# Status note for Madhu: Public Records AI Search, Round 2 build

Prepared October 31, 2026. Read time: about five minutes. Everything below runs on invented data (Tier 0).

## What works (show these)

- **Request & Plan.** The clerk logs a request with its received date and channel. A five-business-day clock (day of receipt not counted, weekends and holidays skipped) shows days left. The AI (or local rules when no model is configured) drafts an editable plan: terms, synonyms, names, dates, record types, departments, exclusions and sources. Nothing is searched until the clerk ticks "I reviewed this plan" and confirms. Confirming locks the plan as a version; editing it later starts the next version.
- **Search Results.** Read-only hybrid search: keyword plus related wording from the city pack, matched on the server. Each candidate shows a match score, a one-sentence "Why it matched", and the passage with the matching words highlighted. Low scores carry an "Arguably responsive" pill. Email threads and near-duplicates are grouped. A banner that cannot be dismissed lists every source NOT searched. Staff mark candidates Relevant, Not relevant or Unsure (keys R, N, U), add notes, and route items to a Records Coordinator.
- **Report.** The search record is built only from stored data: request and clock, confirmed plan and who confirmed it, sources searched and NOT searched, search log, staff marks, known gaps, reproducibility (model, prompt version, plan version, index time), and optional approval. It exports to PDF (print view) and CSV. "Mark handed to city process" releases nothing.
- **Search History, Audit Logs, Evaluation, Settings** as in plan section 8. The audit log is hash-chained (tamper-evident) with a "Verify again" check.
- **Options built:** 1 expand from what you found, 2 preview counts and narrowing, 3 replay closed requests (sample data), 4 source map and custodian checklist, 5 city packs (Bellevue and an invented Sample City), 6 export check records (manual), 7 English and Spanish clarification drafts, 8 AI review package (page and document), 9 plain-language result filters.

## Stubbed or off by default

- SharePoint, OneDrive, Exchange mail and Teams: shown as "Not connected", never searched, always listed as NOT searched.
- Real sources (Gmail, staff uploads, message imports, databases): off unless the server sets `REAL_SOURCES=true`. The hosted demo leaves it off, and nothing in the web interface can turn it on.
- Android texts (Phone Link): experimental and off by default. When a Supervisor turns it on (real sources only), employees review their own matches and send only City business items to the clerk, with an attestation step.
- Second-person approval: off by default. A Supervisor can turn it on in Settings.
- Option 10 (sensitive-content heads-up): roadmap text only (docs/ROADMAP.md). Nothing ships.

## Demo figures (sample data, not production)

On the 18 invented test requests, hybrid search found 75% of the labeled records in the top 10, against 52% for keyword only. Precision in the top 10 was 45% for hybrid and 52% for keyword only. These are targets to be validated during discovery [est.], and the labels are still provisional until two reviewers settle them.

## Known issues

- The Phone Link storage format is not documented by Microsoft. It has been tested only with a sample file.
- PDF export uses the browser's "Save as PDF". The SureAccess scan has not been run yet: each export shows "Scan pending" until Vikram Kamble records a result.
- Demo workspaces are private to each visitor and are deleted after three days.
- On Render's free plan the disk is erased on every restart. That is fine for the Tier 0 demo but not for real data.

## Open items

- Bellevue's system of record (GovQA or other) is not confirmed.
- Approved models and hosting, data retention for AI records, and the CIO exception contact: [NEEDS HUMAN INPUT].
- Real custodian names for the source map come from Bellevue.
- Bellevue's observed holiday list: the pack uses Washington state legal holidays until confirmed.
- Whether Bellevue wants second-person approval of the search record.
- Who can review Spanish drafts (ask Olger Palma).
- Suhas's name and background in team.md: [NEEDS HUMAN INPUT].
