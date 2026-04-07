const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "10mb" }));

const BUILD = "SERVER_BUILD_2026_04_07_FINAL";

const PORT = process.env.PORT || 10000;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function installTracking(page) {
  await page.addInitScript(() => {
    window.__CYRIL_RENDERER__ = {
      fetchCount: 0,
      xhrCount: 0,
      lastMutationAt: Date.now()
    };

    const touch = () => {
      window.__CYRIL_RENDERER__.lastMutationAt = Date.now();
    };

    const obs = new MutationObserver(touch);
    obs.observe(document, { childList: true, subtree: true, attributes: true });

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
  });
}

async function waitForReady(page, options) {
  const timeoutMs = options.timeoutMs || 120000;
  const domStableMs = options.waitForDomStableMs || 4000;
  const preferFlag = options.preferAppReadyFlag === true;

  log("waitForReady timeout", timeoutMs);

  if (preferFlag) {
    try {
      await page.waitForFunction(
        () => window.CYRIL_PDF_READY === true,
        { timeout: timeoutMs }
      );

      log("CYRIL_PDF_READY detected");
      return { mode: "flag" };
    } catch (e) {
      log("flag not detected, fallback");
    }
  }

  await page.waitForFunction(
    ({ domStableMs }) => {
      if (!window.__CYRIL_STATE__) {
        window.__CYRIL_STATE__ = {
          lastHtml: "",
          lastChange: Date.now()
        };
      }

      const state = window.__CYRIL_STATE__;
      const html = document.body.innerHTML;

      if (html !== state.lastHtml) {
        state.lastHtml = html;
        state.lastChange = Date.now();
      }

      return Date.now() - state.lastChange > domStableMs;
    },
    { timeout: timeoutMs },
    { domStableMs }
  );

  return { mode: "heuristic" };
}

app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "cyril-pdf-renderer",
    build: BUILD
  });
});

app.post("/render", async (req, res) => {
  const body = req.body;
  const url = body.url;

  let browser;
  let page;

  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 2200 }
    });

    page = await context.newPage();

    // ***** THIS IS THE CRITICAL FIX *****
    page.setDefaultTimeout(body.timeoutMs || 120000);
    page.setDefaultNavigationTimeout(body.timeoutMs || 120000);

    await installTracking(page);

    page.on("console", msg => {
      log("browser:", msg.text());
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: body.timeoutMs || 120000
    });

    const waitResult = await waitForReady(page, body);

    const pdf = await page.pdf({
      format: body.format || "A4",
      landscape: body.landscape || false,
      printBackground: body.printBackground !== false
    });

    res.json({
      success: true,
      build: BUILD,
      waitMode: waitResult.mode,
      pdfBase64: pdf.toString("base64")
    });

  } catch (e) {
    res.status(500).json({
      success: false,
      build: BUILD,
      message: e.message
    });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  log("Renderer started", BUILD);
});
