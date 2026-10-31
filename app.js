"use strict";
const records = [
    { id: "R-001", title: "Roadway right-of-way work notice", department: "Transportation", type: "Public notice", date: "2024-03-14", text: "A temporary right-of-way use permit was issued for utility work along Cedar Avenue. The notice describes a lane closure, detour routing, work hours, and restoration responsibilities.", terms: ["right-of-way work", "lane closure", "detour", "utility work"] },
    { id: "R-002", title: "Cedar Avenue utility coordination email", department: "Transportation", type: "Email", date: "2024-04-02", text: "Project staff discussed the schedule for underground utility construction and traffic control on Cedar Avenue. Crews planned to close one travel lane overnight and post a signed detour.", terms: ["right-of-way work", "lane closure", "detour", "construction"] },
    { id: "R-003", title: "Annual sidewalk repair contract", department: "Public Works", type: "Contract", date: "2024-02-21", text: "The city awarded a contract for sidewalk panel replacement and curb ramp work. The contractor must maintain pedestrian access and coordinate any temporary street occupancy.", terms: ["sidewalk", "repair", "contract", "street occupancy"] },
    { id: "R-004", title: "Neighborhood traffic calming meeting notes", department: "Transportation", type: "Meeting notes", date: "2023-11-08", text: "Residents discussed speeding, crosswalk visibility, and possible traffic calming on Pine Street. Staff will review speed data before recommending changes.", terms: ["traffic", "speeding", "neighborhood", "crosswalk"] },
    { id: "R-005", title: "Permit review checklist for public right-of-way", department: "Development Services", type: "Policy", date: "2024-01-10", text: "The review checklist covers excavation permits, temporary use of public right-of-way, utility coordination, restoration, and traffic management plans.", terms: ["right-of-way work", "permit", "excavation", "utility", "traffic management"] },
    { id: "R-006", title: "Stormwater inspection summary", department: "Utilities", type: "Report", date: "2024-05-06", text: "Inspectors recorded maintenance needs at two drainage inlets after spring rainfall. Follow-up work included debris removal and a check of nearby catch basins.", terms: ["stormwater", "drainage", "maintenance", "inspection"] },
    { id: "R-007", title: "Parks maintenance work order summary", department: "Parks", type: "Work order", date: "2024-06-18", text: "A crew completed trail surface repairs and replaced damaged signage near the community garden. The work order includes labor hours and materials used.", terms: ["parks", "trail", "repair", "maintenance"] },
    { id: "R-008", title: "Public works weekly project update", department: "Public Works", type: "Report", date: "2024-03-29", text: "The weekly update summarizes active capital projects, construction coordination, sidewalk improvements, and planned utility work across several neighborhoods.", terms: ["construction", "utility work", "sidewalk", "project update"] },
    { id: "R-009", title: "Street use permit application guide", department: "Transportation", type: "Guide", date: "2023-09-12", text: "Applicants seeking temporary street use must provide a work schedule, traffic control plan, insurance details, and a map showing the requested closure limits.", terms: ["street closure", "street use", "permit", "traffic control"] },
    { id: "R-010", title: "Council packet: neighborhood mobility", department: "City Clerk", type: "Council packet", date: "2024-02-13", text: "The council packet includes a presentation about neighborhood mobility, safer crossings, sidewalk gaps, and a proposed process for prioritizing transportation projects.", terms: ["mobility", "sidewalk", "crossings", "transportation"] },
    { id: "R-011", title: "Utility construction public outreach flyer", department: "Utilities", type: "Public notice", date: "2024-04-12", text: "A public flyer explains planned water main replacement, temporary parking restrictions, construction noise, and how residents can contact the project team.", terms: ["utility work", "construction", "parking", "water main"] },
    { id: "R-012", title: "Records retention schedule: project files", department: "City Clerk", type: "Schedule", date: "2022-07-01", text: "The schedule describes retention periods for project correspondence, permit files, inspection reports, meeting records, and contract documentation.", terms: ["project files", "records", "retention", "permit"] },
    { id: "R-013", title: "Bicycle lane striping field notes", department: "Transportation", type: "Field notes", date: "2024-07-24", text: "Field notes document pavement marking installation, temporary lane shifts, crew coordination, and sign placement along the corridor.", terms: ["lane shift", "road work", "striping", "traffic control"] },
    { id: "R-014", title: "Downtown event street closure plan", department: "Transportation", type: "Plan", date: "2023-08-04", text: "The event plan lists street closure hours, barricade locations, detours, emergency access routes, and coordination with transit operators.", terms: ["street closure", "detour", "event", "emergency access"] },
    { id: "R-015", title: "Water service interruption notice", department: "Utilities", type: "Public notice", date: "2024-01-30", text: "Residents were notified of planned water service interruption during valve replacement. The notice provides an expected work window and restoration updates.", terms: ["water service", "valve", "repair", "notice"] },
    { id: "R-016", title: "Building permit review correspondence", department: "Development Services", type: "Email", date: "2024-05-21", text: "Reviewers exchanged comments on a commercial building permit, including site access, construction staging, and utility connection plans.", terms: ["building permit", "construction", "utility", "site access"] },
    { id: "R-017", title: "Traffic signal maintenance log", department: "Transportation", type: "Maintenance log", date: "2024-08-03", text: "Technicians recorded a signal cabinet inspection, replaced a damaged component, and verified pedestrian crossing timing at the intersection.", terms: ["traffic signal", "maintenance", "inspection", "crossing"] },
    { id: "R-018", title: "Cedar Avenue project closeout summary", department: "Public Works", type: "Report", date: "2024-09-09", text: "The closeout summary covers final paving, restoration of the roadway after utility construction, invoice review, and acceptance of completed work.", terms: ["Cedar Avenue", "roadway", "utility construction", "restoration"] }
];
const scenarios = [
    { id: "syn-1", label: "Different wording · road closure", type: "Different wording", request: "Please send records about the road closure on Cedar Avenue while utility crews did their work.", topics: "road closure", alternate: "Cedar Avenue, utility work, lane closure, right-of-way work, detour", relevant: ["R-001", "R-002", "R-005", "R-008", "R-009", "R-011", "R-018"] },
    { id: "syn-2", label: "Different wording · work zone", type: "Different wording", request: "Find plans for the temporary work zone and alternate route during street construction.", topics: "work zone, alternate route, street construction", alternate: "road work, detour, lane closure", relevant: ["R-001", "R-002", "R-009", "R-013", "R-014"] },
    { id: "syn-3", label: "Different wording · water pipe", type: "Different wording", request: "I need notices about crews replacing the water pipe and interrupting service.", topics: "water pipe replacement, service interruption", alternate: "water main, utility construction, valve replacement", relevant: ["R-011", "R-015"] },
    { id: "syn-4", label: "Different wording · pedestrian access", type: "Different wording", request: "Show records about safer walking routes and curb ramps near the neighborhood streets.", topics: "walking routes, curb ramps, neighborhood streets", alternate: "sidewalk, pedestrian access, crosswalk", relevant: ["R-003", "R-004", "R-010"] },
    { id: "syn-5", label: "Different wording · drainage", type: "Different wording", request: "Find inspection records for rainwater drains and catch basins after storms.", topics: "rainwater drains, catch basins, storm inspection", alternate: "stormwater, drainage inlet, rainfall", relevant: ["R-006"] },
    { id: "syn-6", label: "Different wording · site access", type: "Different wording", request: "Find correspondence about getting a construction site connected to utilities and keeping access open.", topics: "construction site, utility connections, access", alternate: "building permit, site access, staging", relevant: ["R-016"] },
    { id: "exact-1", label: "Exact keywords · traffic signal", type: "Exact keyword", request: "Find the traffic signal maintenance log and pedestrian crossing timing inspection from 2024.", topics: "traffic signal, maintenance log, pedestrian crossing, inspection", date: "2024", relevant: ["R-017"] },
    { id: "exact-2", label: "Exact keywords · Cedar Avenue email", type: "Exact keyword", request: "Find the Cedar Avenue utility coordination email dated April 2, 2024.", topics: "Cedar Avenue, utility coordination, email", date: "2024", relevant: ["R-002"] },
    { id: "exact-3", label: "Exact keywords · permit checklist", type: "Exact keyword", request: "Find the public right-of-way permit review checklist.", topics: "public right-of-way, permit review checklist", relevant: ["R-005"] },
    { id: "exact-4", label: "Exact keywords · stormwater", type: "Exact keyword", request: "Find the stormwater inspection summary from May 2024.", topics: "stormwater inspection summary", date: "2024", relevant: ["R-006"] },
    { id: "exact-5", label: "Exact keywords · parks work order", type: "Exact keyword", request: "Find the parks maintenance work order summary from June 2024.", topics: "parks maintenance work order summary", date: "2024", relevant: ["R-007"] },
    { id: "exact-6", label: "Exact keywords · council packet", type: "Exact keyword", request: "Find the council packet about neighborhood mobility and sidewalk gaps.", topics: "council packet neighborhood mobility sidewalk gaps", relevant: ["R-010"] },
    { id: "vague-1", label: "Broad request · city projects", type: "Vague request", request: "I want all records about city projects.", topics: "city projects, project files", needsClarification: true, relevant: ["R-003", "R-005", "R-008", "R-010", "R-012", "R-016", "R-018"] },
    { id: "vague-2", label: "Broad request · permits", type: "Vague request", request: "Send me everything about permits.", topics: "permits", needsClarification: true, relevant: ["R-003", "R-005", "R-009", "R-012", "R-016"] },
    { id: "vague-3", label: "Broad request · maintenance", type: "Vague request", request: "I want all the records about maintenance.", topics: "maintenance", needsClarification: true, relevant: ["R-006", "R-007", "R-017", "R-015"] },
    { id: "vague-4", label: "Broad request · transportation", type: "Vague request", request: "Give me all transportation records.", topics: "transportation", needsClarification: true, relevant: ["R-001", "R-002", "R-004", "R-009", "R-010", "R-013", "R-014", "R-017"] },
    { id: "vague-5", label: "Broad request · utilities", type: "Vague request", request: "I need every record related to utilities.", topics: "utilities", needsClarification: true, relevant: ["R-002", "R-006", "R-011", "R-015", "R-016", "R-018"] },
    { id: "vague-6", label: "Broad request · neighborhood", type: "Vague request", request: "Please provide all records about neighborhoods.", topics: "neighborhood", needsClarification: true, relevant: ["R-004", "R-010", "R-014"] }
];
const synonymGroups = [['road closure', 'street closure', 'lane closure', 'detour', 'traffic control'], ['right-of-way work', 'street use', 'temporary street occupancy', 'excavation permit'], ['utility work', 'utility construction', 'water main', 'underground utility'], ['repair', 'maintenance', 'restoration'], ['pedestrian crossing', 'crosswalk', 'crossing'], ['city projects', 'capital projects', 'project update', 'project files'], ['stormwater', 'rainwater drains', 'drainage inlets', 'catch basins', 'storm inspection'], ['traffic signal', 'signal controller', 'intersection signal', 'traffic light'], ['utility coordination', 'utility coordination email', 'underground utility', 'work schedule'], ['public right-of-way permit', 'permit review checklist', 'excavation permit', 'street use permit'], ['parks maintenance', 'trail repair', 'park work order', 'sign replacement'], ['neighborhood mobility', 'sidewalk gaps', 'pedestrian access', 'safe crossings'], ['water service interruption', 'service outage', 'valve replacement', 'water shutoff']];
let events = loadEventLog(), currentScenario = null, lastResults = [], mode = 'hybrid', reviewMarks = loadStored('synthetic-review-marks', {}), reviewNotes = loadStored('synthetic-review-notes', {}), lastSearchMs = 0, labelVotes = loadLabelVotes(), fullBenchmarkResult = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function loadStored(key, fallback) { try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
}
catch {
    return fallback;
} }
function loadEventLog() { return loadStored('synthetic-search-events', []); }
function addEvent(type, details) { events.push({ time: new Date().toISOString(), actor: $('demo-actor')?.value || loadStored('synthetic-demo-actor', 'Clerk reviewer A'), type, details }); try {
    localStorage.setItem('synthetic-search-events', JSON.stringify(events));
}
catch { } ; renderLog(); }
const page = () => document.body.dataset.page || 'request';
function savedPlan() { return loadStored('synthetic-search-plan', {}); }
function planValue(id) { return $(id) ? $(id).value : String(savedPlan()[id] || ''); }
function savePlan() { const plan = {}; for (const id of ['request-text', 'topics', 'alternate-terms', 'people-orgs', 'date-filter', 'department-filter', 'record-filter', 'repository-filter', 'exclusions', 'clarification-questions'])
    plan[id] = $(id)?.value || ''; plan.confirmed = Boolean($('confirm-plan')?.checked); try {
    localStorage.setItem('synthetic-search-plan', JSON.stringify(plan));
    localStorage.setItem('synthetic-active-request-id', currentScenario?.id || scenarios[0].id);
    localStorage.setItem('synthetic-demo-actor', $('demo-actor')?.value || 'Clerk reviewer A');
}
catch { } ; return plan; }
function initThemePicker() { if (!document.querySelector('[data-theme-choice]')) {
    document.documentElement.dataset.theme = 'archive';
    return;
} const allowed = ['archive', 'signal', 'field-notes'], saved = loadStored('synthetic-ui-theme', 'archive'), initial = allowed.includes(saved) ? saved : 'archive'; document.documentElement.dataset.theme = initial; const buttons = [...document.querySelectorAll('[data-theme-choice]')]; const apply = (theme) => { if (!allowed.includes(theme))
    return; document.documentElement.dataset.theme = theme; buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme))); try {
    localStorage.setItem('synthetic-ui-theme', JSON.stringify(theme));
}
catch { } }; buttons.forEach(button => button.addEventListener('click', () => apply(button.dataset.themeChoice || ''))); apply(initial); }
function loadActiveScenario() { const id = loadStored('synthetic-active-request-id', scenarios[0].id); return scenarios.find(s => s.id === id) || scenarios[0]; }
function init() {
    initThemePicker();
    // Real data mode is handled by client/pages/*.js; the synthetic demo engine stays idle.
    if (document.body?.dataset.mode === 'real' || !['request', 'search', 'evaluation'].includes(page())) {
        renderLog();
        return;
    }
    const p = page();
    if (p === 'request') {
        const select = $('request-select');
        select.innerHTML = scenarios.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
        select.value = loadActiveScenario().id;
        select.addEventListener('change', () => loadScenario());
        $('analyze').onclick = draftPlan;
        $('search').onclick = runSearch;
        for (const id of ['request-text', 'topics', 'alternate-terms'])
            $(id).addEventListener('input', () => renderConceptPreview(currentScenario));
        loadScenario(false);
    }
    if (p === 'search') {
        currentScenario = loadActiveScenario();
        $('active-request').textContent = planValue('request-text') || currentScenario.request;
        document.querySelectorAll('.tab').forEach(t => t.onclick = () => { mode = t.dataset.mode === 'keyword' ? 'keyword' : 'hybrid'; document.querySelectorAll('.tab').forEach(x => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', String(x === t)); }); renderResults(); addEvent('search_method_changed', { scenario: currentScenario.id, method: mode, result_count: lastResults.length }); });
        $('search-again').onclick = () => { mode = 'hybrid'; document.querySelectorAll('.tab').forEach(x => { const active = x.dataset.mode === 'hybrid'; x.classList.toggle('active', active); x.setAttribute('aria-selected', String(active)); }); renderResults(); addEvent('search_run_again', { scenario: currentScenario.id, method: mode, result_count: lastResults.length }); };
        $('route-button').onclick = routeCandidate;
        mode = 'hybrid';
        renderResults();
        addEvent('results_viewed', { scenario: currentScenario.id, request: planValue('request-text') || currentScenario.request, method: mode, result_count: lastResults.length });
    }
    if (p === 'evaluation') {
        currentScenario = loadActiveScenario();
        $('compare').onclick = compare;
        $('full-evaluation').onclick = runFullEvaluation;
        $('export-evaluation').onclick = exportFullEvaluation;
        $('export-log').onclick = exportLog;
        $('clear-log').onclick = clearLog;
        $('run-a11y-check').onclick = runBasicAccessibilityChecks;
        initLabelReview();
    }
    renderLog();
}
function suggestedConcepts(raw) { const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), candidates = synonymGroups.filter(group => group.some(phrase => normalized.includes(phrase.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()))).flatMap(group => group.filter(phrase => !normalized.includes(phrase.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()))); return [...new Set(candidates)].slice(0, 3); }
function renderConceptPreview(s = currentScenario) { if (!s || !$('concept-request'))
    return; const request = $('request-text')?.value.trim() || s.request, custom = request !== s.request, terms = $('topics')?.value.trim() || s.topics || request, alternateInput = $('alternate-terms'), alternate = alternateInput?.value || s.alternate || '', inPlan = alternate.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean), concepts = (inPlan.length ? inPlan : suggestedConcepts(terms)).slice(0, 3); const label = $('concept-route'); if (label)
    label.textContent = custom ? 'CUSTOM SEARCH · EDITED REQUEST' : s.label.toUpperCase(); const query = $('concept-request'); if (query)
    query.textContent = terms; const tags = $('concept-tags'), termsLabel = $('concept-terms-label'); if (termsLabel)
    termsLabel.textContent = inPlan.length ? 'ALTERNATE TERMS · IN THE PLAN' : 'SUGGESTED TERMS · CLICK TO ADD'; if (tags)
    tags.innerHTML = concepts.length ? concepts.map(x => `<button type="button" class="concept-term ${inPlan.some(y => y.toLowerCase() === x.toLowerCase()) ? 'in-plan' : ''}" data-concept="${esc(x)}" aria-pressed="${inPlan.some(y => y.toLowerCase() === x.toLowerCase())}">${esc(x)}<span>${inPlan.some(y => y.toLowerCase() === x.toLowerCase()) ? 'IN PLAN' : '+'}</span></button>`).join('') : '<span class="concept-empty">No curated alternate terms for this request</span>'; tags?.querySelectorAll('.concept-term').forEach(button => button.addEventListener('click', () => { const current = (alternateInput?.value || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean), term = button.dataset.concept, exists = current.some(x => x.toLowerCase() === term.toLowerCase()), next = exists ? current.filter(x => x.toLowerCase() !== term.toLowerCase()) : [...current, term]; if (alternateInput)
    alternateInput.value = next.join(', '); renderConceptPreview(s); })); const candidate = $('concept-candidate'), candidateLabel = $('concept-candidate-label'), record = records.find(r => r.id === s.relevant?.[0]); if (candidate)
    candidate.textContent = custom ? 'Run search to see candidates' : record?.title || 'No labeled example for this request'; if (candidateLabel)
    candidateLabel.textContent = custom ? 'AWAITING SEARCH' : 'SYNTHETIC RECORD EXAMPLE'; const note = $('concept-note'); if (note)
    note.textContent = custom ? 'Preview follows your edited search terms. Candidate list appears after you run the search.' : 'Synthetic preview updates with the selected demo. Click a suggested term to add or remove it from the plan.'; }
function loadScenario(recordEvent = true) { currentScenario = scenarios.find(s => s.id === $('request-select').value) || scenarios[0]; const priorId = loadStored('synthetic-active-request-id', ''), priorPlan = priorId === currentScenario.id ? savedPlan() : {}, initial = { 'request-text': currentScenario.request, topics: currentScenario.topics, 'alternate-terms': currentScenario.alternate || '', 'people-orgs': '', 'date-filter': currentScenario.date || '', 'department-filter': '', 'record-filter': '', 'repository-filter': '', exclusions: '', 'clarification-questions': '' }; for (const [id, value] of Object.entries(initial))
    $(id).value = String(priorPlan[id] ?? value); $('request-type').textContent = currentScenario.type; $('confirm-plan').checked = Boolean(priorPlan.confirmed); $('clarification').hidden = !currentScenario.needsClarification; if (currentScenario.needsClarification && !$('clarification-questions').value)
    draftClarifications(); renderConceptPreview(currentScenario); try {
    localStorage.setItem('synthetic-active-request-id', currentScenario.id);
}
catch { } ; if (recordEvent)
    addEvent('scenario_selected', { scenario: currentScenario.id }); }
function draftClarifications() { $('clarification-questions').value = ['Which project, location, or subject should the search focus on?', 'What date range should staff search?', 'Are there departments or record types to include or exclude?'].join('\n'); }
function draftPlan() { const text = $('request-text').value.toLowerCase(), terms = [...new Set((text.match(/[a-z0-9-]+(?:\s+[a-z0-9-]+){0,2}/g) || []).filter(w => w.length > 3 && !['please', 'records', 'about', 'find', 'send', 'from', 'with', 'that', 'this', 'city', 'want', 'while', 'during', 'everything'].includes(w)))]; if (!$('topics').value.trim())
    $('topics').value = terms.slice(0, 8).join(', '); const broad = text.includes('all records') || text.includes('everything') || text.includes('all the records') || text.length < 30; $('clarification').hidden = !broad; if (broad)
    draftClarifications(); addEvent('plan_drafted', { topics: $('topics').value, clarification_draft: broad }); }
function tokens(s) { const stop = new Set(['a', 'all', 'an', 'and', 'about', 'after', 'are', 'by', 'city', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with', 'find', 'records', 'record', 'please', 'show', 'send', 'give', 'need', 'want']); return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 1 && !stop.has(t)).map(t => t.length > 4 && t.endsWith('ies') ? t.slice(0, -3) + 'y' : t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t); }
function containsTerm(text, term) { const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp('(^|[^a-z0-9])' + escaped + '(?=$|[^a-z0-9])', 'i').test(text); }
function expandedTerms(raw) { const base = tokens(raw), expanded = new Map(base.map(t => [t, { weight: 1, kind: 'query' }])); if (!raw)
    return expanded; const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); for (const group of synonymGroups) {
    const matched = group.some(phrase => normalized.includes(phrase.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
    if (!matched)
        continue;
    for (const phrase of group)
        for (const token of tokens(phrase))
            if (!expanded.has(token))
                expanded.set(token, { weight: .28, kind: 'concept' });
} return expanded; }
function scoreRecord(r, raw, hybrid, filters = {}) {
    const query = hybrid ? expandedTerms(raw) : new Map(tokens(raw).map(t => [t, { weight: 1, kind: 'query' }])), title = (r.title || '').toLowerCase(), meta = (r.department + ' ' + r.type + ' ' + r.terms.join(' ')).toLowerCase(), body = (r.text || '').toLowerCase(), has = (text, term) => tokens(text).includes(term);
    let score = 0, hits = [], evidence = [];
    for (const [t, info] of query) {
        const { weight, kind } = info;
        const inTitle = has(title, t), inMeta = has(meta, t), inBody = has(body, t);
        if (!(inTitle || inMeta || inBody))
            continue;
        const documentFrequency = records.reduce((n, doc) => n + Number(has(doc.title + ' ' + doc.department + ' ' + doc.type + ' ' + doc.text + ' ' + doc.terms.join(' '), t)), 0);
        const rarity = 1 + Math.log((records.length + 1) / (documentFrequency + 1));
        const fieldWeight = inTitle ? 4 : inMeta ? 2 : 1;
        score += weight * rarity * fieldWeight;
        hits.push(t);
        evidence.push({ term: t, kind, field: inTitle ? 'title' : inMeta ? 'metadata' : 'passage' });
    }
    const phrases = raw.toLowerCase().split(/[,;\n]+/).map(x => x.trim()).filter(x => x.length > 3);
    for (const phrase of phrases) {
        if (containsTerm(title, phrase)) {
            score += hybrid ? 7 : 6;
            evidence.push({ term: phrase, kind: 'phrase', field: 'title' });
        }
        else if (containsTerm(body, phrase)) {
            score += hybrid ? 4 : 3;
            evidence.push({ term: phrase, kind: 'phrase', field: 'passage' });
        }
        else if (containsTerm(meta, phrase)) {
            score += hybrid ? 3 : 2;
            evidence.push({ term: phrase, kind: 'phrase', field: 'metadata' });
        }
    }
    const date = filters.date ?? planValue('date-filter'), dep = filters.department ?? planValue('department-filter'), typ = filters.type ?? planValue('record-filter');
    if (date && r.date.includes(date))
        score += .6;
    if (dep && r.department.toLowerCase().includes(dep.toLowerCase()))
        score += .8;
    if (typ && r.type.toLowerCase().includes(typ.toLowerCase()))
        score += .8;
    return { score, hits: [...new Set(hits)], evidence };
}
function searchText(which = 'hybrid', scenario = currentScenario) { return [scenario?.topics || '', which === 'hybrid' ? (scenario?.alternate || '') : ''].join(', '); }
function timedRank(which, scenario = currentScenario, usePlan = true) { const start = performance.now(), results = rank(which, scenario, usePlan); return { results, elapsedMs: performance.now() - start }; }
function runSearch() { if (!$('topics').value.trim())
    return $('topics').focus(); if (!$('confirm-plan').checked) {
    $('confirm-plan').focus();
    $('confirm-plan').reportValidity();
    return;
} currentScenario = scenarios.find(s => s.id === $('request-select').value) || scenarios[0]; const plan = savePlan(); try {
    localStorage.setItem('synthetic-active-request-id', currentScenario.id);
}
catch { } ; const filters = { date: plan['date-filter'], department: plan['department-filter'], record_type: plan['record-filter'], repository: plan['repository-filter'], exclusions: plan.exclusions }; addEvent('plan_confirmed', { scenario: currentScenario.id, request: plan['request-text'], plan }); addEvent('search_run', { scenario: currentScenario.id, request: plan['request-text'], plan, filters, method: 'hybrid', corpus: 'Synthetic demo corpus' }); location.href = '/search.html'; }
function repositoryFor(r) { return ({ Transportation: 'Transportation files', 'Public Works': 'Public Works files', Utilities: 'Utilities files', 'City Clerk': 'City Clerk files', 'Development Services': 'Development Services files', Parks: 'Parks files' })[r.department] || 'Other synthetic files'; }
function groupFor(r) { return ['R-001', 'R-002', 'R-018'].includes(r.id) ? 'Cedar Avenue utility project' : null; }
function rank(which, scenario = currentScenario, usePlan = true) { const date = (usePlan ? planValue('date-filter') : (scenario?.date || '')).trim(), dep = (usePlan ? planValue('department-filter') : '').trim().toLowerCase(), typ = (usePlan ? planValue('record-filter') : '').trim().toLowerCase(), repo = usePlan ? planValue('repository-filter').trim() : '', excluded = tokens(usePlan ? planValue('exclusions') : ''), topic = usePlan ? (planValue('topics') || scenario?.topics || '') : (scenario?.topics || ''), alternate = usePlan ? (planValue('alternate-terms') || scenario?.alternate || '') : (scenario?.alternate || ''), people = usePlan ? planValue('people-orgs') : ''; const raw = [topic, which === 'hybrid' ? alternate : '', people].join(', '), filters = { date, department: dep, type: typ }; return records.filter(r => (!date || r.date.includes(date)) && (!dep || r.department.toLowerCase().includes(dep)) && (!typ || r.type.toLowerCase().includes(typ)) && (!repo || repositoryFor(r) === repo) && !excluded.some(t => containsTerm((r.title + ' ' + r.department + ' ' + r.type + ' ' + r.text + ' ' + r.terms.join(' ')).toLowerCase(), t))).map(r => ({ record: r, ...scoreRecord(r, raw, which === 'hybrid', filters) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id)); }
function highlight(text, hits) { const terms = hits.filter(x => x.length > 2).sort((a, b) => b.length - a.length), variants = terms.flatMap(t => { const safe = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return [safe, t.endsWith('y') ? safe.slice(0, -1) + 'ies' : safe + 's']; }); if (!terms.length)
    return esc(text); const re = new RegExp('\\b(' + variants.join('|') + ')\\b', 'gi'); return text.split(re).map(x => variants.some(v => x.toLowerCase() === v.toLowerCase()) ? `<mark>${esc(x)}</mark>` : esc(x)).join(''); }
function renderResults() { const target = $('results'); if (!target)
    return; const data = rank(mode); lastResults = data; const count = $('result-count'); if (count)
    count.textContent = `${data.length} CANDIDATES · SHOWING TOP ${Math.min(10, data.length)}`; const empty = $('empty-state'); if (empty)
    empty.hidden = data.length > 0; target.innerHTML = data.slice(0, 10).map(({ record: r, score, hits, evidence = [] }, index) => { const matched = hits.slice(0, 5).join(', ') || 'context and metadata', strength = score >= 12 ? 'Strong match' : score >= 5 ? 'Possible match' : 'Weak match', why = [...new Set(evidence.slice(0, 4).map(e => `${e.kind === 'concept' ? 'related concept' : e.kind === 'phrase' ? 'phrase' : 'term'} in ${e.field}`))], reason = why.length ? why.join(' · ') : `${mode === 'hybrid' ? 'Concept-expanded' : 'Keyword'} matches: ${matched}`, mark = reviewMarks[r.id] || ''; return `<article class="result"><div class="result-top"><div class="result-titleline"><span class="result-rank">${String(index + 1).padStart(2, '0')}</span><div><h3>${esc(r.title)}</h3><div class="result-meta">${esc(r.department)} · ${esc(r.type)} · ${esc(r.date)} · ${esc(r.id)}${groupFor(r) ? ` · Related set: ${esc(groupFor(r))}` : ''}</div></div></div><span class="score" data-strength="${strength.toLowerCase().split(' ')[0]}">${strength}</span></div><p class="reason"><b>Why shown:</b> ${esc(reason)}</p><blockquote class="passage">“${highlight(r.text, hits)}”</blockquote><div class="review-actions"><span>Staff review</span>${['relevant', 'not relevant', 'unsure'].map(v => `<button class="mark" data-id="${r.id}" data-value="${v}" aria-pressed="${mark === v}">${v}</button>`).join('')}</div><div class="note-row"><input class="review-note-input" data-id="${r.id}" aria-label="Review note for ${esc(r.title)}" placeholder="Optional staff note" value="${esc(reviewNotes[r.id] || '')}"><button class="save-note secondary" data-id="${r.id}">Save note</button></div></article>`; }).join(''); const route = $('route-record'); if (route)
    route.innerHTML = data.slice(0, 10).map(x => `<option value="${x.record.id}">${x.record.id} · ${esc(x.record.title)}</option>`).join(''); document.querySelectorAll('.mark').forEach(b => b.onclick = () => { reviewMarks[b.dataset.id] = b.dataset.value; localStorage.setItem('synthetic-review-marks', JSON.stringify(reviewMarks)); addEvent('candidate_review_marked', { record_id: b.dataset.id, mark: b.dataset.value }); renderResults(); }); document.querySelectorAll('.save-note').forEach(b => b.onclick = () => { reviewNotes[b.dataset.id] = document.querySelector(`.review-note-input[data-id="${b.dataset.id}"]`).value; localStorage.setItem('synthetic-review-notes', JSON.stringify(reviewNotes)); addEvent('candidate_note_saved', { record_id: b.dataset.id }); renderResults(); }); }
function metrics(data, cutoff, scenario = currentScenario) { const rel = new Set(scenario.relevant), top = data.slice(0, cutoff), hits = top.filter(x => rel.has(x.record.id)).length, first = data.findIndex(x => rel.has(x.record.id)); return { recall: (hits / rel.size * 100).toFixed(0) + '%', precision: (hits / Math.min(cutoff, records.length) * 100).toFixed(0) + '%', first: first < 0 ? 'Not found' : `Rank ${first + 1}` }; }
function compare() { currentScenario = loadActiveScenario(); const h = timedRank('hybrid'), k = timedRank('keyword'), h10 = metrics(h.results, 10), h50 = metrics(h.results, 50), k10 = metrics(k.results, 10), k50 = metrics(k.results, 50), ht = h10.first === 'Not found' ? 'Not found' : `${h.elapsedMs.toFixed(1)} ms`, kt = k10.first === 'Not found' ? 'Not found' : `${k.elapsedMs.toFixed(1)} ms`; const tiles = $('metrics'); if (tiles)
    tiles.innerHTML = [['Recall @ 10', h10.recall, k10.recall], ['Precision @ 10', h10.precision, k10.precision], ['Recall @ 50', h50.recall, k50.recall], ['Precision @ 50', h50.precision, k50.precision]].map(([l, h, k]) => `<div class="metric"><span>${l}</span><b>${h}</b><small>Keyword ${k}</small></div>`).join(''); $('comparison').hidden = false; $('comparison').innerHTML = `<div class="compare-row compare-header"><span>Method</span><strong>Recall @10</strong><strong>Precision @10</strong><strong>Recall @50</strong><strong>Precision @50</strong><strong>First rank</strong><strong>Time to first</strong></div><div class="compare-row"><span>Hybrid simulation</span><strong>${h10.recall}</strong><strong>${h10.precision}</strong><strong>${h50.recall}</strong><strong>${h50.precision}</strong><strong>${h10.first}</strong><strong>${ht}</strong></div><div class="compare-row"><span>Keyword</span><strong>${k10.recall}</strong><strong>${k10.precision}</strong><strong>${k50.recall}</strong><strong>${k50.precision}</strong><strong>${k10.first}</strong><strong>${kt}</strong></div><p class="metric-caveat">Synthetic labels only. Results are target outcomes to be validated during discovery. Timing is local ranking time, not staff time.</p>`; addEvent('comparison_run', { scenario: currentScenario.id, keyword: { recall_at10: k10.recall, precision_at10: k10.precision, recall_at50: k50.recall, precision_at50: k50.precision, first_relevant_rank: k10.first, time_to_first_relevant_ms: kt }, hybrid: { recall_at10: h10.recall, precision_at10: h10.precision, recall_at50: h50.recall, precision_at50: h50.precision, first_relevant_rank: h10.first, time_to_first_relevant_ms: ht } }); }
function runFullEvaluation() {
    const cases = scenarios.map(s => { const methods = {}; for (const method of ['keyword', 'hybrid']) {
        const t = timedRank(method, s, false), at10 = metrics(t.results, 10, s), at50 = metrics(t.results, 50, s);
        methods[method] = { ...at10, at50, first_relevant_rank: at10.first === 'Not found' ? null : Number(at10.first.replace('Rank ', '')), ranking_time_ms: Number(t.elapsedMs.toFixed(3)), time_to_first_relevant_ms: at10.first === 'Not found' ? null : Number(t.elapsedMs.toFixed(3)) };
    } return { id: s.id, label: s.label, type: s.type, methods }; });
    const groups = {};
    for (const type of ['Exact keyword', 'Different wording', 'Vague request']) {
        const rows = cases.filter(c => c.type === type);
        groups[type] = { count: rows.length };
        for (const method of ['keyword', 'hybrid']) {
            for (const key of ['recall', 'precision'])
                for (const n of [10, 50]) {
                    const vals = rows.map(x => Number((n === 10 ? x.methods[method][key] : x.methods[method].at50[key]).replace('%', '')));
                    groups[type][`${method}_${key}_at${n}`] = Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1));
                }
            const ranks = rows.map(x => x.methods[method].first_relevant_rank).filter(x => x !== null), times = rows.map(x => x.methods[method].time_to_first_relevant_ms).filter(x => x !== null);
            groups[type][`${method}_mean_first_relevant_rank`] = ranks.length ? Number((ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1)) : null;
            groups[type][`${method}_mean_time_to_first_relevant_ms`] = times.length ? Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(3)) : null;
        }
    }
    fullBenchmarkResult = { notice: 'Synthetic provisional labels only. Performance figures are target outcomes to be validated during discovery. Hybrid is local keyword plus curated concept expansion, not an embedding model. Time is local ranking latency, not staff time.', corpus_size: records.length, scenario_count: cases.length, groups, scenarios: cases };
    $('full-evaluation-result').hidden = false;
    $('export-evaluation').disabled = false;
    $('full-evaluation-result').innerHTML = `<p class="metric-caveat">${esc(fullBenchmarkResult.notice)} Precision@50 uses ${records.length} synthetic records.</p>${Object.entries(groups).map(([type, g]) => `<h3>${esc(type)} (${g.count} requests)</h3><div class="compare-row compare-header"><span>Method</span><strong>Recall @10</strong><strong>Precision @10</strong><strong>Recall @50</strong><strong>Precision @50</strong><strong>Mean first rank</strong><strong>Mean time to first</strong></div>${['keyword', 'hybrid'].map(m => `<div class="compare-row"><span>${m === 'keyword' ? 'Plain keyword' : 'Synonym + keyword'}</span><strong>${g[`${m}_recall_at10`]}%</strong><strong>${g[`${m}_precision_at10`]}%</strong><strong>${g[`${m}_recall_at50`]}%</strong><strong>${g[`${m}_precision_at50`]}%</strong><strong>${g[`${m}_mean_first_relevant_rank`] ?? 'Not found'}</strong><strong>${g[`${m}_mean_time_to_first_relevant_ms`] === null ? 'Not found' : `${g[`${m}_mean_time_to_first_relevant_ms`]} ms`}</strong></div>`).join('')}`).join('')}<details><summary>Scenario-level results</summary><div class="table-wrap"><table><thead><tr><th>Invented request</th><th>Method</th><th>Recall @10</th><th>Precision @10</th><th>Recall @50</th><th>Precision @50</th><th>First relevant rank</th><th>Time to first relevant</th></tr></thead><tbody>${cases.flatMap(c => ['keyword', 'hybrid'].map(m => `<tr><td>${esc(c.label)}</td><td>${m === 'keyword' ? 'Keyword' : 'Synonym + keyword'}</td><td>${c.methods[m].recall}</td><td>${c.methods[m].precision}</td><td>${c.methods[m].at50.recall}</td><td>${c.methods[m].at50.precision}</td><td>${c.methods[m].first_relevant_rank ?? 'Not found'}</td><td>${c.methods[m].time_to_first_relevant_ms === null ? 'Not found' : `${c.methods[m].time_to_first_relevant_ms} ms`}</td></tr>`)).join('')}</tbody></table></div></details>`;
    addEvent('full_evaluation_completed', { scenario_count: cases.length, corpus_size: records.length, metrics: ['recall@10', 'precision@10', 'recall@50', 'precision@50', 'first relevant rank', 'time to first relevant result'] });
}
function exportFullEvaluation() { if (!fullBenchmarkResult)
    return; download(JSON.stringify(fullBenchmarkResult, null, 2), 'synthetic-full-evaluation.json', 'application/json'); }
function download(text, name, type) { const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); }
function renderLog() { const count = $('log-count'), preview = $('log-preview'), exportButton = $('export-log'); if (count)
    count.textContent = `${events.length} event${events.length === 1 ? '' : 's'}`; if (exportButton)
    exportButton.disabled = !events.length; if (preview)
    preview.innerHTML = events.length ? events.slice(-12).reverse().map(e => `<div class="log-item"><b>${esc(e.type)}</b><br>${esc(new Date(e.time).toLocaleTimeString())} · ${esc(e.actor || 'Demo user')} · ${esc(JSON.stringify(e.details))}</div>`).join('') : 'Search actions and review marks will appear here.'; }
function exportLog() { addEvent('log_exported', { event_count: events.length }); const payload = { notice: 'Synthetic local POC event log. Not a legal search declaration.', exported_at: new Date().toISOString(), scenario: loadActiveScenario().id, events }; download(JSON.stringify(payload, null, 2), 'public-records-search-log.json', 'application/json'); }
function clearLog() { events = []; reviewMarks = {}; reviewNotes = {}; localStorage.removeItem('synthetic-search-events'); localStorage.removeItem('synthetic-review-marks'); localStorage.removeItem('synthetic-review-notes'); renderLog(); }
function routeCandidate() { const recordId = $('route-record').value, owner = $('route-owner').value; if (!recordId) {
    $('route-status').textContent = 'Run a search and choose a candidate first.';
    return;
} addEvent('candidate_routed', { record_id: recordId, synthetic_coordinator: owner }); $('route-status').textContent = `${recordId} routed to ${owner} in this synthetic simulation.`; }
function runBasicAccessibilityChecks() { const fields = [...document.querySelectorAll('input,select,textarea')], unlabeled = fields.filter(el => !el.getAttribute('aria-label') && !(el.labels && el.labels.length)), buttons = [...document.querySelectorAll('button')], unnamed = buttons.filter(el => !el.getAttribute('aria-label') && !el.textContent.trim()), h1 = document.querySelectorAll('h1').length, issues = []; if (unlabeled.length)
    issues.push(`${unlabeled.length} form controls lack a label`); if (unnamed.length)
    issues.push(`${unnamed.length} buttons lack accessible names`); if (h1 !== 1)
    issues.push(`Expected one page heading, found ${h1}`); const msg = issues.length ? `Basic check found: ${issues.join('; ')}.` : `Basic checks passed for ${fields.length} fields, ${buttons.length} buttons and one heading.`; $('a11y-results').textContent = `${msg} This is not a SureAccess result or conformance finding.`; addEvent('basic_accessibility_self_check', { fields: fields.length, buttons: buttons.length, issues }); }
function loadLabelVotes() { try {
    return JSON.parse(localStorage.getItem('synthetic-label-votes') || '{}');
}
catch {
    return {};
} }
function initLabelReview() { const scenarioSelect = $('label-scenario'), roleSelect = $('label-role'); if (!scenarioSelect || !roleSelect)
    return; scenarioSelect.innerHTML = scenarios.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join(''); scenarioSelect.onchange = renderLabelWorksheet; roleSelect.onchange = renderLabelWorksheet; $('export-labels').onclick = exportLabelWorksheet; renderLabelWorksheet(); }
function renderLabelWorksheet() { const sid = $('label-scenario').value || scenarios[0].id, role = $('label-role').value, scenario = scenarios.find(s => s.id === sid); const labels = labelVotes[sid] || {}; let marked = 0; const rows = records.map(r => { const entry = labels[r.id] || {}, value = entry[role] || ''; if (value)
    marked++; const options = ['', 'relevant', 'not relevant', 'unsure'].map(v => `<option value="${v}" ${value === v ? 'selected' : ''}>${v || 'Choose label'}</option>`).join(''); const reference = role === 'adjudicator' ? (scenario.relevant.includes(r.id) ? 'Yes' : 'No') : 'Hidden during reviewer entry'; const reviewStatus = role === 'adjudicator' ? (labels[r.id]?.reviewer1 && labels[r.id]?.reviewer2 ? (labels[r.id].reviewer1 === labels[r.id].reviewer2 ? 'Agreement' : 'Difference') : 'Pending') : 'Not shown'; return `<tr><td><b>${esc(r.id)}</b><br>${esc(r.title)}<small>${esc(r.department)} · ${esc(r.type)} · ${esc(r.date)}</small></td><td><select class="label-choice" aria-label="${role === 'reviewer1' ? 'Reviewer 1' : role === 'reviewer2' ? 'Reviewer 2' : 'Adjudicated'} label for ${esc(r.title)}" data-record="${r.id}">${options}</select></td><td>${reference}</td><td>${reviewStatus}</td></tr>`; }).join(''); $('label-table').innerHTML = `<table><thead><tr><th>Record</th><th>${role === 'reviewer1' ? 'Reviewer 1' : role === 'reviewer2' ? 'Reviewer 2' : 'Adjudicated label'}</th><th>${role === 'adjudicator' ? 'Provisional example label' : 'Reference labels'}</th><th>Review status</th></tr></thead><tbody>${rows}</tbody></table>`; $('label-progress').textContent = `${marked} of ${records.length} records labeled in this view`; document.querySelectorAll('.label-choice').forEach(select => select.onchange = () => { const rid = select.dataset.record; labelVotes[sid] ??= {}; labelVotes[sid][rid] ??= {}; labelVotes[sid][rid][role] = select.value; try {
    localStorage.setItem('synthetic-label-votes', JSON.stringify(labelVotes));
}
catch { } ; addEvent('label_record_saved', { scenario: sid, record_id: rid, reviewer_role: role, label: select.value }); renderLabelWorksheet(); }); }
function exportLabelWorksheet() { const header = ['scenario_id', 'request_type', 'request_text', 'record_id', 'record_title', 'reviewer_1_label', 'reviewer_2_label', 'adjudicated_label', 'provisional_example_label', 'review_status']; const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`; const lines = [header.map(q).join(',')]; for (const s of scenarios)
    for (const r of records) {
        const v = labelVotes[s.id]?.[r.id] || {}, disagree = v.reviewer1 && v.reviewer2 && v.reviewer1 !== v.reviewer2;
        lines.push([s.id, s.type, s.request, r.id, r.title, v.reviewer1 || '', v.reviewer2 || '', v.adjudicator || '', s.relevant.includes(r.id) ? 'relevant' : 'not relevant', disagree ? 'Difference' : v.reviewer1 && v.reviewer2 ? 'Agreement' : 'Pending'].map(q).join(','));
    } const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'synthetic-label-review.csv'; a.click(); URL.revokeObjectURL(url); }
document.addEventListener('DOMContentLoaded', init);
