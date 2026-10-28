# Synthetic pre-access demo plan

As of October 26, 2026. This plan uses invented requests and invented records only. It does not claim that a public corpus has been selected, downloaded, or cleared for reuse. The Bellevue Document Center terms issue remains a gate for any future public Bellevue files. The user-selected synthetic-data path avoids that download.

## Corpus and provenance

The app's 18 records are authored synthetic examples embedded in `app.js`. `demo-corpus.json` inventories the records and identifies each as synthetic. Source URL and retrieval date are intentionally null because no external file was retrieved. The set covers public notices, email, contracts, meeting notes, policy, reports, work orders, guides, packets, schedules, plans, field notes, and maintenance logs.

## Request set and relevance labels

The app contains 18 invented requests: six exact-keyword, six different-wording, and six vague. Existing `scenario.relevant` lists are provisional synthetic gold labels, not human-validated ground truth. `label-review.csv` is the double-review and adjudication worksheet. Two people must label independently and resolve differences before reporting human-reviewed evaluation results. The app does not claim that this has been done.

## Task coverage against the brief

| Brief item | Synthetic demo implementation | Status and boundary |
| --- | --- | --- |
| Choose corpus and log provenance | 18 synthetic records with full text, source URL and retrieval-date fields in `demo-corpus.json` | Implemented as a synthetic substitute. No Bellevue or JLARC files were downloaded. |
| Create 15 to 20 invented requests | 18 scenarios in `demo-requests.json` | Implemented, with six exact, six different-wording, and six vague requests. |
| Double label and adjudicate | In-app Reviewer 1, Reviewer 2, and Adjudicator views; CSV export | Workflow implemented. Human independent labels and adjudication remain to be completed. The local UI cannot verify reviewer identity. |
| Compare keyword and hybrid | `benchmark.js` runs plain keyword and synonym-expanded keyword over all scenarios, with recall/precision at 10 and 50, first relevant rank, per-request time to first relevant result, and request-type means | Implemented as a lexical prototype benchmark. This is not embedding-based semantic retrieval and not the 1.2 production hybrid pipeline. Results use provisional labels. |
| Build staff screens and export log | Editable, confirmable search plan; clarification drafts; repository filter; ranked results with reason and passage; staff marks/notes; synthetic coordinator route; session log and JSON export | Implemented for synthetic records. Routing is simulated. There is no persistent city audit store. |
| Accessibility review | Semantic structure, explicit form labels, keyboard focus indication, responsive layout, and live feedback status | UI is described as WCAG 2.1 AA-aligned. SureAccess scan and Vikram Kamble review are not completed. |

## 1.2 architecture boundary

The brief describes an LLM-generated plan and ranking reasons, embedding-based semantic retrieval, source permission trimming, duplicate/thread grouping, repository connectors, coordinator routing, and an append-only audit store. The current POC implements none of the external-model or city-system integrations. It uses local rule-based plan drafts and curated synonym expansion over synthetic text. Search reasons are generated from matching terms. The app has no login and cannot preserve source permissions because it has no connected repositories. These boundaries are visible in the README and must be resolved only after model, hosting, repository, and data-access approvals.

## Benchmark

Run `node benchmark.js` to compare plain keyword ranking with synonym-expanded keyword ranking across all 18 scenarios. It reports recall and precision at 10 and 50, first relevant rank, per-request time to first relevant result, and means by request type. Vague scenarios are included for retrieval metrics but also require staff clarification. With only 18 documents, top 50 means the full corpus. Runtime is not staff time. All figures are synthetic and are target outcomes to be validated during discovery.

## Interface and review

The app provides request editing, editable plan fields and clarification questions, plan confirmation, repository filtering, ranked results with reasons and highlighted passages, staff review marks and notes, a simulated coordinator route, a session log, and JSON export. A full-set evaluation can be run and exported. The local rules and synonym expansion are not an embedding model or LLM. No source connectors, authentication, or repository permissions are implemented. The pilot-planning and feedback page was removed on October 28; the current app has three pages. The accessibility self-check remains a basic local aid, not an audit.

## Accessibility

The interface uses semantic headings, explicit form labels, keyboard focus indicators, responsive layout, and status messages. This is an implementation checklist, not a SureAccess scan or conformance finding. A SureAccess scan and Vikram Kamble review are validation tasks; record findings and fixes here after they occur. Describe the interface as WCAG 2.1 AA-aligned. Do not claim compliant or certified.

## Remaining evidence gates

- Two independent human labelers and adjudication.
- SureAccess scan and reviewer sign-off.
- If changing from synthetic to public documents: confirm terms permit the intended use, then record each file URL and retrieval date.
- Validate retrieval on the human-reviewed labels. Do not use this synthetic benchmark as performance evidence for Bellevue records.
