const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const API_KEY = process.env.API_KEY || "";
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 120000);
const DEFAULT_WAIT_FOR_NETWORK_IDLE_MS = Number(process.env.DEFAULT_WAIT_FOR_NETWORK_IDLE_MS || 1500);
const DEFAULT_WAIT_FOR_DOM_STABLE_MS = Number(process.env.DEFAULT_WAIT_FOR_DOM_STABLE_MS || 1500);
const DEFAULT_VIEWPORT_WIDTH = Number(process.env.DEFAULT_VIEWPORT_WIDTH || 1440);
const DEFAULT_VIEWPORT_HEIGHT = Number(process.env.DEFAULT_VIEWPORT_HEIGHT || 2200);
const LOG_BROWSER_CONSOLE = (process.env.LOG_BROWSER_CONSOLE || "true").toLowerCase() === "true";
const LOG_REQUESTS = (process.env.LOG_REQUESTS || "true").toLowerCase() === "true";
const BLOCK_MEDIA = (process.env.BLOCK_MEDIA || "false").toLowerCase() === "true";
const USER_AGENT = process.env.USER_AGENT || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function errorLog(...args) {
  console.error(new Date().toISOString(), ...args);
}

function assertAuthorized(req, res) {
  if (!API_KEY) return true;
  const incoming = req.header("x-api-key");
  if (!incoming || incoming !== API_KEY) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function getSafeNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function installTracking(page) {
  await page.addInitScript(() => {
    window.__CYRIL_RENDERER__ = {
      fetchCount: 0,
      xhrCount: 0,
      lastMutationAt: Date.now(),
      mutationObserverInstalled: false,
      fetchInstalled: false,
      xhrInstalled: false
    };

    function ensureMutationObserver() {
      if (window.__CYRIL_RENDERER__.mutationObserverInstalled) return;
      window.__CYRIL_RENDERER__.mutationObserverInstalled = true;
      const observer = new MutationObserver(() => {
        window.__CYRIL_RENDERER__.lastMutationAt = Date.now();
      });
      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    }

    function ensureFetchWrap() {
      if (window.__CYRIL_RENDERER__.fetchInstalled || !window.fetch) return;
      window.__CYRIL_RENDERER__.fetchInstalled = true;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        window.__CYRIL_RENDERER__.fetchCount++;
        window.__CYRIL_RENDERER__.lastMutationAt = Date.now();
        try {
          return await originalFetch(...args);
        } finally {
          window.__CYRIL_RENDERER__.fetchCount--;
          window.__CYRIL_RENDERER__.lastMutationAt = Date.now();
        }
      };
    }

    function ensureXhrWrap() {
      if (window.__CYRIL_RENDERER__.xhrInstalled || !window.XMLHttpRequest) return;
      window.__CYRIL_RENDERER__.xhrInstalled = true;
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function(...args) {
        this.__cyrilTracked = true;
        return originalOpen.apply(this, args);
      };

      XMLHttpRequest.prototype.send = function(...args) {
        if (this.__cyrilTracked) {
          window.__CYRIL_RENDERER__.xhrCount++;
          window.__CYRIL_RENDERER__.lastMutationAt = Date.now();
          this.addEventListener("loadend", () => {
            window.__CYRIL_RENDERER__.xhrCount--;
            window.__CYRIL_RENDERER__.lastMutationAt = Date.now();
          }, { once: true });
        }
        return originalSend.apply(this, args);
      };
    }

    ensureMutationObserver();
    ensureFetchWrap();
    ensureXhrWrap();
  });
}

async function waitForFonts(page) {
  try {
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    });
  } catch (e) {
    // no-op
  }
}

async function waitForAppToBeReady(page, options) {
  const timeoutMs = getSafeNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 300000);
  const networkIdleMs = getSafeNumber(options.waitForNetworkIdleMs, DEFAULT_WAIT_FOR_NETWORK_IDLE_MS, 0, 10000);
  const domStableMs = getSafeNumber(options.waitForDomStableMs, DEFAULT_WAIT_FOR_DOM_STABLE_MS, 0, 10000);
  const preferAppReadyFlag = toBoolean(options.preferAppReadyFlag, true);

  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  await page.waitForLoadState("load", { timeout: timeoutMs });

  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 30000) });
  } catch (e) {
    // some apps never reach strict networkidle
  }

  await waitForFonts(page);

  if (preferAppReadyFlag) {
    try {
      await page.waitForFunction(() => window.CYRIL_PDF_READY === true, { timeout: 15000 });
      await sleep(networkIdleMs);
      return { mode: "explicit-flag" };
    } catch (e) {
      // fallback to heuristic mode
    }
  }

  await page.waitForFunction(
    ({ domStableMs }) => {
      const state = window.__CYRIL_RENDERER__ || {
        fetchCount: 0,
        xhrCount: 0,
        lastMutationAt: Date.now()
      };

      const now = Date.now();
      const domStable = now - state.lastMutationAt >= domStableMs;
      const networkQuiet = state.fetchCount === 0 && state.xhrCount === 0;

      const visibleSpinner = !!document.querySelector(
        '.slds-spinner, lightning-spinner, .loading, [aria-busy="true"], [data-loading="true"]'
      );

      return networkQuiet && domStable && !visibleSpinner;
    },
    { timeout: timeoutMs },
    { domStableMs }
  );

  await sleep(networkIdleMs);
  return { mode: "heuristic" };
}

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "OK",
    service: "cyril-pdf-renderer"
  });
});

app.post("/render", async (req, res) => {
  if (!assertAuthorized(req, res)) return;

  const body = req.body || {};
  const targetUrl = body.url;

  if (!targetUrl || typeof targetUrl !== "string") {
    return res.status(400).json({ success: false, message: "Missing url" });
  }

  let browser;
  let context;
  let page;

  try {
    if (LOG_REQUESTS) {
      log("/render request", JSON.stringify({
        url: targetUrl,
        format: body.format || "A4",
        landscape: !!body.landscape,
        timeoutMs: getSafeNumber(body.timeoutMs, DEFAULT_TIMEOUT_MS),
        preferAppReadyFlag: toBoolean(body.preferAppReadyFlag, true)
      }));
    }

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: {
        width: getSafeNumber(body.viewportWidth, DEFAULT_VIEWPORT_WIDTH, 320, 4000),
        height: getSafeNumber(body.viewportHeight, DEFAULT_VIEWPORT_HEIGHT, 320, 6000)
      },
      userAgent: USER_AGENT
    });

    if (BLOCK_MEDIA) {
      await context.route("**/*", async route => {
        const req = route.request();
        const type = req.resourceType();
        if (["media"].includes(type)) {
          return route.abort();
        }
        return route.continue();
      });
    }

    page = await context.newPage();
    await installTracking(page);

    if (LOG_BROWSER_CONSOLE) {
      page.on("console", msg => {
        log("[browser console]", msg.type(), msg.text());
      });
    }

    page.on("pageerror", err => {
      errorLog("[page error]", err && err.stack ? err.stack : String(err));
    });

    page.on("requestfailed", request => {
      errorLog("[request failed]", request.failure()?.errorText, request.url());
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: getSafeNumber(body.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 300000)
    });

    const waitResult = await waitForAppToBeReady(page, body);

    const pdfBuffer = await page.pdf({
      format: body.format || "A4",
      landscape: !!body.landscape,
      printBackground: toBoolean(body.printBackground, true),
      preferCSSPageSize: toBoolean(body.preferCSSPageSize, true),
      margin: {
        top: body.marginTop || "8mm",
        right: body.marginRight || "8mm",
        bottom: body.marginBottom || "8mm",
        left: body.marginLeft || "8mm"
      }
    });

    const diagnostics = await page.evaluate(() => {
      const state = window.__CYRIL_RENDERER__ || {};
      return {
        readyFlag: window.CYRIL_PDF_READY === true,
        fetchCount: state.fetchCount || 0,
        xhrCount: state.xhrCount || 0,
        bodyReadyAttr: document.body ? document.body.getAttribute("data-cyril-pdf-ready") : null,
        title: document.title || null
      };
    });

    return res.json({
      success: true,
      message: "Rendered successfully",
      pdfBase64: pdfBuffer.toString("base64"),
      pageCount: null,
      waitMode: waitResult.mode,
      diagnostics
    });
  } catch (e) {
    errorLog("[render error]", e && e.stack ? e.stack : String(e));
    return res.status(500).json({
      success: false,
      message: e && e.message ? e.message : String(e)
    });
  } finally {
    try {
      if (page) await page.close();
    } catch (e) {}
    try {
      if (context) await context.close();
    } catch (e) {}
    try {
      if (browser) await browser.close();
    } catch (e) {}
  }
});

app.listen(PORT, HOST, () => {
  log(`CYRIL PDF Renderer listening on http://${HOST}:${PORT}`);
});
