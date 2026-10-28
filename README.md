# Public Records AI Search POC

## Current implementation

A local, staff-only workflow demo for the Bellevue Public Records AI Search concept. It contains 18 invented request scenarios across exact-keyword, different-wording, and vague-request cases, plus a synthetic set of 18 records. It contains no Bellevue source documents, non-public data, external AI calls, or connections to city systems.

The search-plan draft uses local rules. Retrieval uses phrase-aware keyword scoring, light plural normalization, rare-term weighting, title and metadata boosts, curated concept expansion, and strict date, department, record-type, repository, and exclusion filters. Result explanations identify whether evidence came from a query term, a phrase, or a related concept. Match-strength labels describe ranking bands, not probabilities. This is a local lexical retrieval prototype, not an embedding model, LLM, or the proposed production hybrid pipeline. Synthetic labels are illustrative only; all performance targets are target outcomes to be validated during discovery.

## Run locally

The browser application is authored in TypeScript (`app.ts`) and compiled to the checked-in `app.js` browser asset. Build it with:

```powershell
npm ci
npm run build
```

Then run the server from this folder:

```powershell
node server.js
```

The server prints a local URL and same-network URL. The demo has three pages: Request & Plan (`/`), Search Results (`/search.html`), and Evaluation (`/evaluation.html`). The request and plan persist in browser storage between pages. The server has no login. It serves a synthetic-data demo and does not collect user feedback. Stop the server with Ctrl+C.

## Deploy on Render

The repository includes `render.yaml`. In Render, create a Blueprint from `https://github.com/suhas882/poc` and select the `master` branch, or create a Web Service from that repository with build command `npm ci && npm run build`, start command `node server.js`, and health check path `/api/health`. The server binds to Render's `PORT` and `0.0.0.0`.

The app is public when deployed and has no authentication. Keep the corpus synthetic and do not enter city or requester data.

## Included flows

- 18 invented requests in three groups, with synthetic relevant-record labels.
- Editable request, topics, alternate terms, people or organizations, date, likely department, record type, and exclusions.
- Local-rule plan drafting and staff-reviewed clarification question drafts. Nothing is sent to requesters.
- Synonym-plus-keyword ranking alongside a keyword baseline.
- Ranked candidates with matching passage highlights, an explanatory reason, a synthetic label indicator, and a provisional “Arguably responsive” confidence band.
- Staff review marks and notes on candidates.
- Recall and precision at top 10 and top 50, first relevant rank, and local time to a ranked list containing the first labeled relevant record. The top 50 is calculated from the 18-record synthetic corpus, not a representative source index. Timing is not a staff-time measure.
- Draft event log with query, filters, candidate count, simulated staff role, review actions, and JSON export. It is browser-local, not a city audit store.
- Synthetic repository filter and a synthetic coordinator routing interaction. It does not assign work to a person.
- Editable clarification-question drafts and explicit search-plan confirmation before search.
- Full 18-scenario evaluation and JSON export. This runs the local lexical prototype, not embeddings or an LLM.
- Per-scenario and request-type comparisons include recall and precision at 10 and 50, first relevant rank, and local time-to-first-relevant result. The ranking-time measure is not staff time.
- Basic page-structure accessibility self-check. It is not SureAccess.
- Responsive layout, keyboard focus styles, labels, and WCAG 2.1 AA-aligned intent. This is not a compliance claim or completed accessibility audit.
- Three separate navigable pages for request planning, ranked results, and evaluation/label review. Search-log export and accessibility self-check are on Evaluation.
- Three selectable visual themes: Archive, Signal, and Field Notes. The design switcher is available in the top bar on every page, updates immediately, and remembers the choice in browser storage.
- A two-minute, captioned browser video builder and a short MP4 walkthrough, both using synthetic examples only.

## Core checks

Run `npm run build` to compile TypeScript and check the generated browser script and server syntax. Run `node smoke-test.js` to check scenario count and coverage, corpus load, both search modes, safe passage highlighting, labeled retrieval across all 18 scenarios, clarification drafts, top-10/top-50 calculations, metadata filters, and the synthetic different-wording/exact-match benchmark bars.

## Boundaries and next steps

- Do not add public city documents until the team confirms their terms permit this use. Current records are synthetic.
- Do not add a model call until Bellevue's approved model and hosting are known and the AI review and data-sharing gates are met.
- No repository connector exists. The app searches only the bundled synthetic records and applies no source permissions.
- No authentication or multi-user attribution exists. Logs are a local draft, not an official diligent-search record.
- The preview is unauthenticated. The app uses synthetic records only and has no feedback-collection endpoint.
- No OCR, vector embeddings, GovQA integration, or real repository connectors exist. The related-record tag is illustrative and does not perform deduplication/thread grouping.
- Coordinator routing is a UI simulation only. It does not notify or assign a real person. Clarification questions are editable drafts and are never sent to requesters.
- The labels are provisional and not independently adjudicated. The in-app worksheet supports Reviewer 1, Reviewer 2, and Adjudicator views, but it cannot verify identities or enforce blind review. Metrics do not establish expected pilot performance.
- No responsiveness, privilege, exemption, redaction, disclosure, or requester-response decision is automated.
- Pilot planning, feedback collection, and city access tiers are not part of the current app interface.
- Planned work still depends on partner decisions about corpus terms, approved hosting/model, repositories, closed-request ground truth, baselines, and permissions.

## Implementation progress

- 2026-10-26: Built and started the local demo shell, synthetic corpus, plan editor, search, review flow, metrics, and log export.
- 2026-10-26: Corrected metadata filtering after smoke checks found it was initially a rank boost rather than a strict filter.
- 2026-10-26: Expanded from three examples to 18 invented scenarios, added plan fields, clarification drafts, passage highlights, review notes, and top-10/top-50 comparison.
- 2026-10-26: Separated the plain keyword baseline from synonym expansion and tuned a different-wording scenario. The all-scenario benchmark is in `benchmark-results.json`; its precision denominator is 10 for top 10 and 18 for top 50 because the corpus has 18 records. On different-wording cases, synonym-expanded retrieval has 100% recall at 10 and 50 versus 87.1% and 90.5% for plain keyword, and pooled precision is also higher at 10 (31.7% versus 23.3%) and 50 (17.6% versus 13.9%). Exact-case recall ties at 100%. These are synthetic demo results, not validated performance claims.
- 2026-10-27: Split the previous single page into Request & Plan, Search Results, Evaluation, and Pilot & Feedback pages. Added shared local plan/request state and server routes for each page. Verified JavaScript syntax, core search smoke checks, and reviewer-label workflow checks. Updated preview started on port 8766 because port 8765 was already occupied by the prior server process.
- 2026-10-28: Removed Pilot & Feedback from the app navigation and removed its page and feedback endpoint. Moved search-log export and the basic accessibility self-check to Evaluation. The app now has three navigable pages.
- 2026-10-28: Refreshed the interface with a dark civic-search header, lime accent, responsive editorial layout, clearer candidate ranks, match-strength bands instead of misleading percentages, and more explicit evidence explanations. Improved lexical retrieval with phrase recognition, plural normalization, rare-term weighting, field-aware scoring, and conservative phrase-triggered concept expansion. Regenerated the synthetic benchmark; results remain illustrative and do not validate city-record performance.
- 2026-10-28: Added three persistent visual design choices across Request & Plan, Search Results, and Evaluation: Archive, Signal, and Field Notes. Theme choice changes the color system, typography, component geometry, and decorative treatment without changing search behavior.
- 2026-10-26: Added a full 18-scenario benchmark command and JSON snapshot, a synthetic-record provenance manifest, a separate reviewer/adjudicator label worksheet with CSV export, and a demo plan documenting remaining human review gates. SureAccess scan and Vikram Kamble review remain outstanding.
- 2026-10-26: Added `server.js` with same-network preview and a local JSONL feedback store. Added a feedback form to the POC.
- 2026-10-26: Started the LAN preview at `http://192.168.0.11:8765/`. Submitted a test comment through the browser, confirmed local save, then removed the test-only feedback file. The feedback file will be created when the friend sends the first real comment.
- 2026-10-27: Added editable clarification drafts, search-plan confirmation, synthetic repository filter and routing, full-corpus evaluation export, tier/milestone/KPI simulator, AI guardrail panel, and basic accessibility self-check. Updated the plan and README to describe simulation boundaries.

## Added demo artifacts

- `DEMO-PLAN.md` records the synthetic-only scope, workflow, and open validation gates.
- `demo-corpus.json` inventories all 18 invented records, including their synthetic text. Source URLs and retrieval dates are null because no external documents were downloaded.
- `demo-requests.json` contains the 18 invented requests and provisional labels.
- `build-demo-assets.js` rebuilds the corpus and request JSON from the app data.
- `benchmark.js` runs keyword and synonym-expanded keyword baselines over all 18 scenarios. Output is saved in `benchmark-results.json`.
- The app's label review worksheet stores reviewer 1, reviewer 2, and adjudicator labels in browser local storage and exports all request-record pairs to CSV. Human independent review is not represented as completed.
- `label-review.csv` is a blank spreadsheet template for an offline review workflow.
- `PITCH-VIDEO-SCRIPT.md` gives the two-minute story and lists claims the video must avoid.
- `video-output/bellevue-public-records-poc-walkthrough.mp4` is a 40-second, silent, captioned walkthrough rendered at 1080p from the synthetic demo storyboard. `video-output/bellevue-public-records-poc-storyboard.pptx` is the editable source.

The benchmark averages each metric across scenarios within each request type. Precision@10 divides by 10. Precision@50 divides by 18 because the corpus contains 18 records. All results are synthetic and are target outcomes to be validated during discovery. They are not city-record performance results.

Run `node label-workflow-test.js` to check reviewer views, hiding provisional labels during review, browser-local persistence, and adjudication difference flags.
