const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "10mb" }));

const BUILD = "SERVER_BUILD_2026_04_07_TRACE_4";
const PORT = process.env.PORT || 10000;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function installTracking(page) {
  await page.addInitScript(() => {
    window.__CYRIL_RENDERER__ = {
      fetchCount: 0,
      xhrCount: 0,
      lastMutationAt: Date.now()
    };

    const touch = () => {
      try {
        window.__CYRIL_RENDERER__.lastMutationAt = Date.now();
      } catch (e) {}
    };

    const obs = new MutationObserver(() => {
      touch();
    });

    obs.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = async (...args) => {
        window.__CYRIL_RENDERER__.fetchCount++;
        touch();
        try {
          return await origFetch(...args);
        } finally {
          window.__CYRIL_RENDERER__.fetchCount--;
          touch();
        }
      };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(...args) {
      return origOpen.apply(this, args);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      window.__CYRIL_RENDERER__.xhrCount++;
      touch();

      this.addEventListener("loadend", function() {
        try {
          window.__CYRIL_RENDERER__.xhrCount--;
          touch();
        } catch (e) {}
      });

      return origSend.apply(this, args);
    };
  });
}

async function getDiagnostics(page) {
  try {
    return await page.evaluate(() => {
      const r = window.__CYRIL_RENDERER__ || {};
      const tracker = window.CYRIL_PDF_TRACKER || {};
      const pending = Array.isArray(tracker.pending)
        ? tracker.pending
        : Array.isArray(tracker._pending)
        ? tracker._pending
        : [];

      return {
        readyFlag: window.CYRIL_PDF_READY === true,
        trackerReady: tracker.ready === true,
        trackerPendingCount: pending.length,
        fetchCount: r.fetchCount || 0,
        xhrCount: r.xhrCount || 0,
        lastMutationAt: r.lastMutationAt || null,
        title: document.title || "",
        bodyReadyAttr: document.body ? document.body.getAttribute("data-cyril-pdf-ready") : null
      };
    });
  } catch (e) {
    return {
      diagnosticsError: e.message
    };
  }
}

async function waitForReady(page, options) {
  const totalTimeoutMs = options.timeoutMs || 120000;
  const fallbackDelayMs = options.waitForDomStableMs || 3000;
  const preferFlag = options.preferAppReadyFlag === true;
  const signalWaitMs = Math.min(
    Math.max(options.flagWaitMs || 15000, 1000),
    totalTimeoutMs
  );

  log("waitForReady:start", JSON.stringify({
    totalTimeoutMs,
    fallbackDelayMs,
    preferFlag,
    signalWaitMs
  }));

  if (preferFlag) {
    try {
      log("waitForReady:waiting-for-ready-signal");

      await page.waitForFunction(
        () => {
          const winFlag = window.CYRIL_PDF_READY === true;

          const bodyAttr =
            document.body &&
            document.body.getAttribute("data-cyril-pdf-ready") === "true";

          const tracker = window.CYRIL_PDF_TRACKER || {};
          const pending = Array.isArray(tracker.pending)
            ? tracker.pending
            : Array.isArray(tracker._pending)
            ? tracker._pending
            : [];

          const trackerReady =
            tracker.ready === true && pending.length === 0;

          return winFlag || bodyAttr || trackerReady;
        },
        {},
        { timeout: signalWaitMs }
      );

      const matchedDiagnostics = await getDiagnostics(page);
      log("waitForReady:ready-signal-detected", JSON.stringify(matchedDiagnostics));
      return { mode: "ready-signal" };
    } catch (e) {
      log("waitForReady:ready-signal-not-detected", e.message);
    }
  }

  log("waitForReady:fixed-delay:start", fallbackDelayMs);
  await page.waitForTimeout(fallbackDelayMs);
  log("waitForReady:fixed-delay:done");

  return { mode: "fixed-delay" };
}

app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "cyril-pdf-renderer",
    build: BUILD
  });
});

app.post("/render", async (req, res) => {
  const body = req.body || {};
  const url = body.url;

  let browser;
  const startedAt = Date.now();

  try {
    log("render:start", JSON.stringify({
      build: BUILD,
      url,
      timeoutMs: body.timeoutMs || 120000,
      format: body.format || "A4",
      landscape: body.landscape || false,
      printBackground: body.printBackground !== false,
      preferAppReadyFlag: body.preferAppReadyFlag === true,
      waitForDomStableMs: body.waitForDomStableMs || 3000,
      flagWaitMs: body.flagWaitMs || 15000
    }));

    log("render:launching-browser");
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      headless: true
    });
    log("render:browser-launched");

    log("render:creating-context");
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 2200 }
    });
    log("render:context-created");

    log("render:creating-page");
    const page = await context.newPage();
    log("render:page-created");

    page.setDefaultTimeout(body.timeoutMs || 120000);
    page.setDefaultNavigationTimeout(body.timeoutMs || 120000);

    page.on("console", msg => {
      log("browser:console", msg.type(), msg.text());
    });

    page.on("pageerror", err => {
      log("browser:pageerror", err.message);
    });

    // LOG ONLY. Do not fail render because of CSP/CORS/network noise.
    page.on("requestfailed", request => {
      const failure = request.failure();
      log(
        "browser:requestfailed",
        request.url(),
        failure ? failure.errorText : "unknown"
      );
    });

    log("render:install-tracking");
    await installTracking(page);
    log("render:tracking-installed");

    log("render:goto:start", url);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: body.timeoutMs || 120000
    });
    log("render:goto:done");

    try {
      const title = await page.title();
      log("render:page-title", title);
    } catch (e) {
      log("render:page-title:error", e.message);
    }

    const beforeWaitDiagnostics = await getDiagnostics(page);
    log("render:diagnostics:before-wait", JSON.stringify(beforeWaitDiagnostics));

    const waitResult = await waitForReady(page, body);
    log("render:wait-complete", waitResult.mode);

    const afterWaitDiagnostics = await getDiagnostics(page);
    log("render:diagnostics:after-wait", JSON.stringify(afterWaitDiagnostics));

    log("render:pdf:start");
    const pdf = await page.pdf({
      format: body.format || "A4",
      landscape: body.landscape || false,
      printBackground: body.printBackground !== false
    });
    log("render:pdf:done", "bytes=" + pdf.length);

    const totalMs = Date.now() - startedAt;
    log("render:success", "totalMs=" + totalMs);

    return res.json({
      success: true,
      build: BUILD,
      waitMode: waitResult.mode,
      totalMs,
      diagnostics: afterWaitDiagnostics,
      pdfBase64: pdf.toString("base64")
    });
  } catch (e) {
    const totalMs = Date.now() - startedAt;
    log("render:error", e.message, "totalMs=" + totalMs);

    return res.status(500).json({
      success: false,
      build: BUILD,
      totalMs,
      message: e.message
    });
  } finally {
    if (browser) {
      try {
        log("render:browser:closing");
        await browser.close();
        log("render:browser:closed");
      } catch (closeErr) {
        log("render:browser:close-error", closeErr.message);
      }
    }
  }
});

app.listen(PORT, () => {
  log("Renderer started", BUILD, "PORT=" + PORT);
});
