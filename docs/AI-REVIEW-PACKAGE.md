# Bellevue AI review package (draft for the AI Questionnaire)

Prepared for Madhu (owner of the AI Questionnaire, due November 3, 2026). Facts come from how the proof of concept is built. Bellevue treats AI records (prompts, logs) as public records, so every part of this package is written to be exported. Nothing here states that any model or hosting is approved.

## 1. Data flow

1. A clerk enters the request text, the date received and the channel.
2. The request text, the list of departments and record types, and the names of connected sources go to the AI model, which returns a draft search plan. If no model is configured, local rules draft the plan.
3. Staff edit the plan, choose sources, tick "I reviewed this plan" and confirm. The confirmed plan is locked and versioned.
4. The search runs on the application server against read-only indexes of the chosen sources. Ranking uses keyword matching plus related wording from the city pack, computed on the server.
5. Staff review candidates and mark them. The search record (report) is generated from stored data and handed to the city's existing process.

A diagram of this flow is on the "Bellevue AI review package" page under Settings.

## 2. What the model sees

| Purpose | Sent to the model | Never sent |
|---|---|---|
| Search plan | Request text; department and record-type lists; source names | Record content, candidate text, staff marks, texts from phones |
| Clarification drafts | Request text only | Everything else |

This is enforced in code and checked by an automated test that fails if record or candidate text appears in any model call. Outside embedding services (which would need record text) stay off until an approved model and hosting are named (`EMBEDDINGS_RECORD_CONTENT_APPROVED`). The model name and prompt version are logged with every plan and every search.

## 3. Human review steps

- The clerk edits and confirms every plan. Nothing is searched before that.
- Staff mark every candidate: relevant, not relevant or unsure, with name, time and an optional note. The model never writes marks.
- Optional second-person approval by a Supervisor before handoff.
- The tool never decides responsiveness, exemptions, redaction or release, and never says a search is complete. Reports say "candidates found in the sources searched".
- Clarification drafts are never sent by the tool. The Spanish draft is labeled "Draft translation: needs human review" and cannot be copied until a person ticks the review box.

## 4. Logging and exports

- An append-only audit log records sign-ins, requests, plan drafts and edits, confirmations, searches (including refused ones), record views, marks, routing, permission changes (old and new values), exports, handoffs and settings changes.
- Each entry is hashed together with the previous one. The Audit Logs page verifies the chain and names the first broken entry. This is tamper-evident, not tamper-proof.
- One-click CSV export of the audit log, the search log and the candidate list; PDF of the search record.

## 5. Approved models and hosting

[NEEDS HUMAN INPUT: which models and hosting Bellevue approves.] The build can run with no model at all (local rules), so the pilot is not blocked by this decision.

## 6. CIO exception template (fields)

- Purpose and scope: AI-assisted search planning for public records requests. Staff decide.
- Data tier: Tier 0 now; Tier 1 (closed requests in a city sandbox) and Tier 2 (live read-only shadow mode) only after approval.
- Data that reaches the model: request text and plan only (section 2).
- Retention and logging: section 4 and section 8.
- Human review: section 3.
- Contact and form number: [NEEDS HUMAN INPUT: Bellevue CIO contact and form number].

## 7. Bias and fairness check (approach)

- Compare recall in the top 10 and top 50 across request kinds and departments on the labeled test set, for keyword-only and hybrid search.
- Two people label the test set independently; a Supervisor settles differences.
- Check plain-language English drafts with a reading-level score and have a person review Spanish drafts.
- All targets are outcomes to be validated during discovery [est.].

## 8. Data retention

This build deletes search history after 365 days and audit events after 730 days by default (configurable). Demo workspaces are deleted after three days. [NEEDS HUMAN INPUT: Bellevue retention schedule for AI records.]

## Later phase (not built, not claimed)

Redaction support, exemption-log drafting, native-format production, portal integration, and a sensitive-content heads-up for reviewers (roadmap text only).
