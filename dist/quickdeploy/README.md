# Quick-deploy build

Three files instead of twenty-five, for pasting straight into the Apps Script
web editor at [script.google.com](https://script.google.com):

| File | Generated from |
|------|-----------------|
| `Code.gs` | `src/server/00_Config.gs` … `16_Code.gs`, concatenated in load order |
| `Index.html` | `src/client/Styles.html`, `ClientCore.html`, `ClientComponents.html`, the 9 `View*.html` modules, and `ClientBoot.html`, with the `<?!= include(...) ?>` calls resolved inline |
| `appsscript.json` | copied unchanged from `src/appsscript.json` |

Same application, same behaviour — this only changes how many files you paste.
`src/` remains the source of truth; if you edit the app, edit there and
regenerate this folder, not the other way round.

## Deploying from these 3 files

1. Create a new Apps Script project (or open the one bound to your workbook).
2. Delete the default `Code.gs`, paste this `Code.gs` in its place.
3. Add an HTML file named `Index`, paste `Index.html`'s contents in.
4. Replace the project's `appsscript.json` (Project Settings → "Show
   `appsscript.json`" → edit) with this one.
5. Run `setupFirstRun` once from the editor.
6. Deploy → New deployment → Web app (execute as the accessing user, access
   restricted to your organisation) and open the URL.

Full walkthrough, including source-workbook connection and first-cycle setup,
is in [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md).
