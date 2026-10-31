# Bellevue Public Records Search: UI Refresh

This is a standalone local copy of the synthetic-data POC with an additional fourth visual direction, **Civic Pulse**. The original three page flows and the Archive, Signal, and Field Notes themes remain available. The new theme is stored per browser, like the other themes.

The TypeScript browser source is `app.ts`; `app.js` is generated for the static pages. No real Bellevue records, external AI, or city-system connections are included.

## Run

```powershell
npm ci
npm run build
node server.js
```

The server prints the local preview address. Set `PORT=8767` if you want to run this copy beside the main project.

## Checks

```powershell
npm run build
node smoke-test.js
node label-workflow-test.js
```

This local folder is a review copy. It does not change or deploy the main Render site.
