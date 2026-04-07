# cyril-pdf-renderer

A Docker-based Playwright renderer for Salesforce Experience Cloud pages.

It exposes:

- `GET /health`
- `POST /render`

The renderer opens the target page in a real browser, waits for the page to finish rendering, and returns a base64 PDF payload.

## Files in this package

- `package.json`
- `server.js`
- `Dockerfile`
- `render.yaml`
- `.env.example`
- `.dockerignore`
- `.gitignore`

## Deploy to Render

This package is set up as a Docker web service. Render supports Docker-based deploys, and Blueprint files use `render.yaml` at the repository root. Render web services must bind to `0.0.0.0`, and the default expected port is `10000`. citeturn790875search0turn790875search1turn790875search3

### Steps

1. Create a new Git repository named `cyril-pdf-renderer`.
2. Put all files from this package at the repository root.
3. Push the repository to GitHub.
4. In Render, create a new web service from that repository, or deploy it as a Blueprint using the included `render.yaml`.
5. Set the `API_KEY` environment variable in Render.
6. After deployment, verify:
   - `GET /health`
   - `POST /render`

## Endpoint

### POST /render

Request body example:

```json
{
  "url": "https://your-experience-site.example.com/s/corporate-member-summary?generatePDF=true&id=001XXXXXXXXXXXX",
  "timeoutMs": 120000,
  "printBackground": true,
  "format": "A4",
  "landscape": false,
  "waitForNetworkIdleMs": 1500,
  "waitForDomStableMs": 1500,
  "preferAppReadyFlag": true
}
```

Response example:

```json
{
  "success": true,
  "message": "Rendered successfully",
  "pdfBase64": "JVBERi0xLjQK...",
  "pageCount": null,
  "waitMode": "explicit-flag",
  "diagnostics": {
    "readyFlag": true,
    "fetchCount": 0,
    "xhrCount": 0,
    "bodyReadyAttr": "true",
    "title": "Corporate Member Summary"
  }
}
```

## Optional page-ready signal

If your Experience page sets `window.CYRIL_PDF_READY = true` after all dynamic components finish loading, the renderer will prefer that explicit signal.

If that signal is missing, the renderer falls back to heuristics:

- DOM stopped changing
- no tracked `fetch` / `XMLHttpRequest` activity
- no visible loading spinner selectors

## Salesforce callout target

Point your Salesforce Named Credential endpoint to your deployed Render URL, for example:

```text
https://your-render-service.onrender.com
```

Then Salesforce can call:

```text
POST /render
```

## Security

Set `API_KEY` in Render and send the same value in the `x-api-key` header from Salesforce.

## Notes

- This package is only the external renderer.
- Your Salesforce Apex code stays in Salesforce.
- Any optional `window.CYRIL_PDF_READY` helper script belongs in your Experience site, not in this renderer repo.
