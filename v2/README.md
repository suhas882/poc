# Public Records AI Search POC — v2 (React + TypeScript)

This is the v1 demo in the parent folder, rebuilt with **React 18, TypeScript (strict) and Vite**. It has the same synthetic corpus, the same 18 invented requests, and identical ranking: `tests/parity.test.ts` runs v1 `app.js` side by side with the v2 engine and checks they match. The v1 app in the parent folder is untouched.

All records are synthetic. No city systems, real records, model calls or external services are connected.

## Run it

```powershell
cd v2
node server.mjs          # serves the prebuilt dist/ folder, no install needed
```

Open http://localhost:8765/. To change the code:

```powershell
npm install
npm run dev              # live-reload dev server
npm test                 # unit tests and v1 parity tests (vitest)
npm run build            # type-check and production build into dist/
npm run benchmark        # all-scenario benchmark, writes benchmark-results.json
```

## Deploy on Render

Create a Web Service with **Root Directory** `v2`, build command `npm ci && npm run build`, start command `node server.mjs`, and health check path `/api/health`. The root `render.yaml` still deploys v1.

## Project layout

```
src/
  data/        records.ts, scenarios.ts, synonyms.ts   (typed synthetic data)
  lib/         search.ts      tokenising, scoring, filters, highlighting, plan drafting
               evaluation.ts  recall/precision @10/@50, method comparison, full benchmark
               labels.ts      reviewer/adjudicator status and CSV export
               storage.ts     guarded localStorage and file download helpers
  state/       AppState.tsx   one typed store for plan, log, review marks, labels, theme
  components/  Layout (top bar, stepper, hero), Toast
  pages/       RequestPlan, SearchResults, Evaluation  (each lazy-loaded)
  styles/      app.css (the records-room design, light and dark)
tests/         search.test.ts (ported v1 smoke and label checks), parity.test.ts
server.mjs     zero-dependency static server with the v1 security headers and CSP
```

## What changed from v1

**Code**
- Strict TypeScript throughout, with types for records, scenarios, plans, results, log events and labels.
- Search logic is now pure functions instead of reading form fields from the page. It can be tested without a browser.
- Each record's tokens and document frequencies are computed once. v1 re-tokenised the whole corpus for every query term. Results are unchanged.
- Passages are highlighted as React elements instead of HTML strings, so there is no `innerHTML`.
- Each page is a separate chunk loaded on demand. The production server sends long-lived cache headers for hashed assets and keeps v1's CSP (`script-src 'self'; style-src 'self'`) with no inline scripts.
- Old URLs (`/search.html`, `/evaluation.html`) redirect to the new routes.

**Design (redesigned 2026-10-30)**
- A records room rather than a dashboard. The three steps are manila folder tabs, and each page is the open folder.
- The search plan is laid out like a ruled request form. A side panel shows how the search widens: the plan's terms, the alternate terms (click to remove) and suggested ones (click to add).
- Candidates are index cards: a serif rank, the record excerpt in Source Serif 4 on faint ruled lines with matched words highlighted, a plain-language "Why it's here", and a Relevant / Unsure / Not relevant switch that colours the card's edge.
- The review panel shows progress and filters (to review, relevant, unsure, not relevant), and has a practice hand-off to a coordinator.
- Evaluate has an on-page contents list, large method figures with the point difference, tables with inline bars, a label worksheet with a reviewer switch, and a readable activity log.
- Type: Public Sans (the US government's open typeface) for the interface and Source Serif 4 for record text. Both are self-hosted, so the strict CSP still holds.
- Light and dark modes follow the system setting and can be switched in the header. They replace the three v1 themes.
- Focus moves to the new page on navigation, every control is labelled, and the in-app accessibility check passes. This is not a SureAccess result or a conformance claim.

Local storage keys are prefixed `v2-`, so v1 and v2 sessions don't mix.

## Boundaries

Unchanged from v1: a synthetic corpus only, no repository connectors, no authentication, simulated routing, and provisional labels that have not been independently adjudicated. The browser log is a local draft, not an audit record. See `../README.md` and `../DEMO-PLAN.md`.
