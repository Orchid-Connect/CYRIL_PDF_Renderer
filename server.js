const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

const BUILD_MARKER = "SERVER_BUILD_2026_04_07_V4";

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const API_KEY = process.env.API_KEY || "";
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 180000);
const DEFAULT_WAIT_FOR_NETWORK_IDLE_MS = Number(process.env.DEFAULT_WAIT_FOR_NETWORK_IDLE_MS || 3000);
const DEFAULT_WAIT_FOR_DOM_STABLE_MS = Number(process.env.DEFAULT_WAIT_FOR_DOM_STABLE_MS || 4000);
const DEFAULT_VIEWPORT_WIDTH = Number(process.env.DEFAULT_VIEWPORT_WIDTH || 1440);
const DEFAULT_VIEWPORT_HEIGHT = Number(process.env.DEFAULT_VIEWPORT_HEIGHT || 2200);
const LOG_BROWSER_CONSOLE = (process.env.LOG_BROWSER_CONSOLE || "true").toLowerCase() === "true";
const LOG_REQUESTS = (process.env.LOG_REQUESTS || "true").toLowerCase() === "true";
const BLOCK_MEDIA = (process.env.BLOCK_MEDIA || "false").toLowerCase() === "true";
const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
    res.status(401).json({ success: false, message: "Unauthorized", build: BUILD_MARKER });
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    function touch() {
      window.__CYRIL_RENDERER__.lastMutationAt = Date.now();
    }

    function ensureMutationObserver() {
      if (window.__CYRIL_RENDERER__.mutationObserverInstalled) return;
      window.__CYRIL_RENDERER__.mutationObserverInstalled = true;

      const target = document.documentElement || document;
      if (!target) return;

      const observer = new MutationObserver(() => {
        touch();
      });

      observer.observe(target, {
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
        touch();
        try {
          return await originalFetch(...args);
        } finally {
          window.__CYRIL_RENDERER__.fetchCount--;
          touch();
        }
      };
    }

    function ensureXhrWrap() {
      if (window.__CYRIL_RENDERER__.xhrInstalled || !window.XMLHttpRequest) return;
      window.__CYRIL_RENDERER__.xhrInstalled = true;

      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (...args) {
        this.__cyrilTracked = true;
        return originalOpen.apply(this, args);
      };

      XMLHttpRequest.prototype.send = function (...args) {
        if (this.__cyrilTracked) {
          window.__CYRIL_RENDERER__.xhrCount++;
          touch();

          this.addEventListener(
            "loadend",
            () => {
              window.__CYRIL_RENDERER__.xhrCount--;
              touch();
            },
            { once: true }
          );
        }
        return originalSend.apply(this, args);
      };
    }

    ensureMutationObserver();
    ensureFetchWrap();
    ensureXhrWrap();
    touch();
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

async function getReadyDiagnostics(page) {
  try {
    return await page.evaluate(() => {
      const rendererState = window.__CYRIL_RENDERER__ || {};
      return {
        readyFlag: window.CYRIL_PDF_READY === true,
        bodyReadyAttr: document.body ? document.body.getAttribute("data-cyril-pdf-ready") : null,
        pending:
          window.CYRIL_PDF_TRACKER && typeof window.CYRIL_PDF_TRACKER.getPending === "function"
            ? window.CYRIL_PDF_TRACKER.getPending()
            : null,
        fetchCount: rendererState.fetchCount || 0,
        xhrCount: rendererState.xhrCount || 0,
        title: document.title || null,
        href: window.location ? window.location.href : null
      };
    });
  } catch (e) {
    return {
      readyFlag: false,
      bodyReadyAttr: null,
      pending: null,
      fetchCount: 0,
      xhrCount: 0,
      title: null,
      href: null,
      diagnosticsError: e && e.message ? e.message : String(e)
    };
  }
}

async function waitForAppToBeReady(page, options) {
  const timeoutMs = getSafeNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 300000);
  const networkIdleMs = getSafeNumber(
    options.waitForNetworkIdleMs,
    DEFAULT_WAIT_FOR_NETWORK_IDLE_MS,
    0,
    60000
  );
  const domStableMs = getSafeNumber(
    options.waitForDomStableMs,
    DEFAULT_WAIT_FOR_DOM_STABLE_MS,
    0,
    60000
  );
  const preferAppReadyFlag = toBoolean(options.preferAppReadyFlag, true);

  log("[waitForAppToBeReady] build =", BUILD_MARKER);
  log("[waitForAppToBeReady] timeoutMs =", timeoutMs);
  log("[waitForAppToBeReady] networkIdleMs =", networkIdleMs);
  log("[waitForAppToBeReady] domStableMs =", domStableMs);
  log("[waitForAppToBeReady] preferAppReadyFlag =", preferAppReadyFlag);

  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  await page.waitForLoadState("load", { timeout: timeoutMs });

  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 30000) });
    log("[waitForAppToBeReady] networkidle reached");
  } catch (e) {
    log("[waitForAppToBeReady] networkidle not reached, continuing");
  }

  await waitForFonts(page);

  if (preferAppReadyFlag) {
    try {
      log("[waitForAppToBeReady] waiting for window.CYRIL_PDF_READY === true");

      await page.waitForFunction(
        () => {
          return window.CYRIL_PDF_READY === true;
        },
        { timeout: timeoutMs }
      );

      await sleep(networkIdleMs);

      const diagnostics = await getReadyDiagnostics(page);
      diagnostics.mode = "appReadyFlag";
      diagnostics.build = BUILD_MARKER;
      log("[waitForAppToBeReady] appReadyFlag diagnostics", JSON.stringify(diagnostics));
      return diagnostics;
    } catch (e) {
      log(
        "[waitForAppToBeReady] CYRIL_PDF_READY not detected, falling back to heuristic wait:",
        e && e.message ? e.message : String(e)
      );
    }
  }

  await page.waitForFunction(
    ({ domStableMs }) => {
      if (!window.__CYRIL_PDF_STATE__) {
        window.__CYRIL_PDF_STATE__ = {
          lastHtml: "",
          lastChangeAt: Date.now()
        };
      }

      const state = window.__CYRIL_PDF_STATE__;
      const bodyHtml = document.body ? document.body.innerHTML : "";

      if (bodyHtml !== state.lastHtml) {
        state.lastHtml = bodyHtml;
        state.lastChangeAt = Date.now();
      }

      const now = Date.now();
      const visibleSpinner = !!document.querySelector(
        '.slds-spinner, .loading, [aria-busy="true"], lightning-spinner'
      );

      const domStable = now - state.lastChangeAt >= domStableMs;

      return domStable && !visibleSpinner;
    },
    { timeout: timeoutMs },
    { domStableMs }
  );

  await sleep(networkIdleMs);

  const diagnostics = await getReadyDiagnostics(page);
  diagnostics.mode = "heuristic";
  diagnostics.build = BUILD_MARKER;
  log("[waitForAppToBeReady] heuristic diagnostics", JSON.stringify(diagnostics));
  return diagnostics;
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "CYRIL PDF Renderer is running",
    service: "cyril-pdf-renderer",
    build: BUILD_MARKER
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "OK",
    service: "cyril-pdf-renderer",
    build: BUILD_MARKER
  });
});

app.post("/render", async (req, res) => {
  if (!assertAuthorized(req, res)) return;

  const body = req.body || {};
  const targetUrl = body.url;

  if (!targetUrl || typeof targetUrl !== "string") {
    return res.status(400).json({
      success: false,
      message: "Missing url",
      build: BUILD_MARKER
    });
  }

  let browser;
  let context;
  let page;

  try {
    const effectiveTimeoutMs = getSafeNumber(body.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 300000);
    const effectivePreferAppReadyFlag = toBoolean(body.preferAppReadyFlag, true);

    if (LOG_REQUESTS) {
      log(
        "/render request",
        JSON.stringify({
          build: BUILD_MARKER,
          url: targetUrl,
          format: body.format || "A4",
          landscape: !!body.landscape,
          timeoutMs: effectiveTimeoutMs,
          preferAppReadyFlag: effectivePreferAppReadyFlag
        })
      );
    }

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
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
      await context.route("**/*", async (route) => {
        const request = route.request();
        const type = request.resourceType();
        if (["media"].includes(type)) {
          return route.abort();
        }
        return route.continue();
      });
    }

    page = await context.newPage();
    await installTracking(page);

    if (LOG_BROWSER_CONSOLE) {
      page.on("console", (msg) => {
        log("[browser console]", msg.type(), msg.text());
      });
    }

    page.on("pageerror", (err) => {
      errorLog("[page error]", err && err.stack ? err.stack : String(err));
    });

    page.on("requestfailed", (request) => {
      errorLog("[request failed]", request.failure()?.errorText, request.url());
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: effectiveTimeoutMs
    });

    const waitResult = await waitForAppToBeReady(page, body);
    log("[render wait result]", JSON.stringify(waitResult));

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

    const diagnostics = await getReadyDiagnostics(page);

    return res.json({
      success: true,
      message: "Rendered successfully",
      build: BUILD_MARKER,
      pdfBase64: pdfBuffer.toString("base64"),
      pageCount: null,
      waitMode: waitResult ? waitResult.mode : null,
      diagnostics
    });
  } catch (e) {
    errorLog("[render error]", e && e.stack ? e.stack : String(e));
    return res.status(500).json({
      success: false,
      message: e && e.message ? e.message : String(e),
      build: BUILD_MARKER
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
  log(`CYRIL PDF Renderer listening on http://${HOST}:${PORT} build=${BUILD_MARKER}`);
});
