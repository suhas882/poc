const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const fields = {
  'request-text': { value: '' },
  'topics': { value: 'road closure, Cedar Avenue, utility work' },
  'alternate-terms': { value: 'lane closure, right-of-way work, detour' },
  'concept-request': { textContent: '' },
  'concept-route': { textContent: '' },
  'concept-tags': { innerHTML: '', querySelectorAll: () => [] },
  'concept-candidate': { textContent: '' },
  'concept-candidate-label': { textContent: '' },
  'concept-note': { textContent: '' },
  'people-orgs': { value: '' },
  'exclusions': { value: '' },
  'clarification-questions': { innerHTML: '' },
  'clarification': { hidden: false },
  'date-filter': { value: '2024' },
  'department-filter': { value: '' },
  'record-filter': { value: '' }
};
const document = {
  getElementById: id => fields[id] || (fields[id] = { value: '', hidden: false, innerHTML: '', disabled: false }),
  querySelectorAll: () => [],
  addEventListener: () => {}
};
const context = vm.createContext({ document, console, Date, Set, Map, performance: { now: () => Date.now() } });
vm.runInContext(fs.readFileSync('app.js', 'utf8'), context);
const scenarios = JSON.parse(vm.runInContext('JSON.stringify(scenarios)', context));
assert.equal(scenarios.length, 18, '18 demo request scenarios load');
assert.equal(scenarios.filter(s => s.type === 'Exact keyword').length, 6, 'six exact-match scenarios load');
assert.equal(scenarios.filter(s => s.type === 'Different wording').length, 6, 'six different-wording scenarios load');
assert.equal(scenarios.filter(s => s.type === 'Vague request').length, 6, 'six clarification scenarios load');
assert.equal(vm.runInContext('records.length', context), 18, 'synthetic corpus loads');
assert.equal(vm.runInContext("typeof initLabelReview", context), 'function', 'two-reviewer worksheet is implemented');
assert.equal(vm.runInContext("typeof exportLabelWorksheet", context), 'function', 'label worksheet CSV export is implemented');
assert.equal(vm.runInContext("typeof exportLog", context), 'function', 'search log JSON export is implemented');
let hybrid = vm.runInContext("rank('hybrid')", context);
let keyword = vm.runInContext("rank('keyword')", context);
assert(hybrid.length > 0 && keyword.length > 0, 'both search modes return candidates');
const ids = hybrid.slice(0, 10).map(x => x.record.id);
const targetIds = scenarios[0].relevant;
assert(ids.some(id => targetIds.includes(id)), 'synonym scenario retrieves labeled records in top 10');
assert(hybrid[0].score > 0 && keyword[0].score > 0, 'ranked candidates have positive scores');
assert(vm.runInContext('highlight("A road closure affects the street.", ["road", "closure"])', context).includes('<mark>road</mark>'), 'matching evidence is highlighted');
fields['department-filter'].value = 'Parks';
const filtered = vm.runInContext("rank('hybrid')", context);
assert(filtered.every(x => x.record.department === 'Parks'), 'department filter restricts results');
fields['department-filter'].value = '';
fields['date-filter'].value = '2023';
const dateFiltered = vm.runInContext("rank('hybrid')", context);
assert(dateFiltered.every(x => x.record.date.includes('2023')), 'date filter restricts results');
fields['date-filter'].value = '';
fields['record-filter'].value = 'email';
const typeFiltered = vm.runInContext("rank('hybrid')", context);
assert(typeFiltered.every(x => x.record.type.toLowerCase().includes('email')), 'record-type filter restricts results');
fields['record-filter'].value = '';
fields['exclusions'].value = 'Cedar';
const exclusionFiltered = vm.runInContext("rank('hybrid')", context);
assert(exclusionFiltered.every(x => !x.record.text.toLowerCase().includes('cedar') && !x.record.title.toLowerCase().includes('cedar')), 'exclusions remove matching records');
fields['exclusions'].value = '';
for (const scenario of scenarios) {
  fields.topics.value = scenario.topics;
  fields['alternate-terms'].value = scenario.alternate || '';
  fields['people-orgs'].value = '';
  fields['date-filter'].value = scenario.date || '';
  vm.runInContext(`currentScenario=scenarios.find(s=>s.id===${JSON.stringify(scenario.id)})`, context);
  const results = vm.runInContext("rank('hybrid')", context);
  assert(results.some(x => scenario.relevant.includes(x.record.id)), `scenario ${scenario.id} retrieves a labeled record`);
}
vm.runInContext('currentScenario=scenarios[0];draftClarifications()', context);
assert(fields['clarification-questions'].value.includes('date range'), 'editable clarification draft contains useful narrowing questions');
const top10 = vm.runInContext("metrics(rank('hybrid'),10)", context);
const top50 = vm.runInContext("metrics(rank('hybrid'),50)", context);
assert(Number(top50.recall.replace('%','')) >= Number(top10.recall.replace('%','')), 'top-50 recall is not below top-10 recall');
const synonymScenario = scenarios[0];
fields.topics.value = synonymScenario.topics;
fields['alternate-terms'].value = synonymScenario.alternate;
fields['date-filter'].value = synonymScenario.date || '';
vm.runInContext(`currentScenario=scenarios.find(s=>s.id===${JSON.stringify(synonymScenario.id)})`, context);
const synonymHybrid = vm.runInContext("metrics(rank('hybrid'),10)", context);
const synonymKeyword = vm.runInContext("metrics(rank('keyword'),10)", context);
assert(Number(synonymHybrid.recall.replace('%','')) > Number(synonymKeyword.recall.replace('%','')), 'hybrid retrieval improves recall for different-wording scenario');
const exactScenario = scenarios.find(s => s.id === 'exact-1');
fields.topics.value = exactScenario.topics;
fields['alternate-terms'].value = '';
fields['date-filter'].value = exactScenario.date;
vm.runInContext(`currentScenario=scenarios.find(s=>s.id===${JSON.stringify(exactScenario.id)})`, context);
const exactHybrid = vm.runInContext("metrics(rank('hybrid'),10)", context);
const exactKeyword = vm.runInContext("metrics(rank('keyword'),10)", context);
assert.equal(exactHybrid.recall, exactKeyword.recall, 'hybrid matches keyword recall on exact-match scenario');
vm.runInContext('runFullEvaluation()', context);
const batch = JSON.parse(vm.runInContext('JSON.stringify(fullBenchmarkResult)', context));
assert.equal(batch.scenario_count, 18, 'in-app full evaluation covers all scenarios');
assert.equal(batch.groups['Exact keyword'].hybrid_recall_at10, 100, 'batch evaluation preserves exact-match recall');
assert(batch.groups['Different wording'].hybrid_recall_at10 > batch.groups['Different wording'].keyword_recall_at10, 'batch evaluation verifies different-wording recall lift');
const previewScenario = scenarios.find(s => s.id === 'exact-2');
fields['request-text'].value = previewScenario.request;
fields.topics.value = previewScenario.topics;
fields['alternate-terms'].value = '';
vm.runInContext("renderConceptPreview(scenarios.find(s=>s.id==='exact-2'))", context);
assert(fields['concept-route'].textContent.includes('CEDAR AVENUE EMAIL'), 'hero preview reflects the selected demo scenario');
assert(fields['concept-request'].textContent.includes('utility coordination'), 'hero preview reflects selected scenario search terms');
assert(fields['concept-candidate'].textContent.includes('Cedar Avenue utility coordination email'), 'hero preview candidate follows selected scenario labels');
const stormwaterScenario = scenarios.find(s => s.id === 'exact-4');
fields['request-text'].value = stormwaterScenario.request;
fields.topics.value = stormwaterScenario.topics;
fields['alternate-terms'].value = '';
vm.runInContext("renderConceptPreview(scenarios.find(s=>s.id==='exact-4'))", context);
assert(fields['concept-tags'].innerHTML.includes('rainwater drains'), 'hero preview suggests curated alternates for the selected topic');
assert(fields['concept-terms-label'].textContent.includes('SUGGESTED TERMS'), 'preview distinguishes suggestions from terms already in the plan');
fields['request-text'].value = 'Find every email about a custom topic.';
vm.runInContext("renderConceptPreview(scenarios.find(s=>s.id==='exact-2'))", context);
assert(fields['concept-candidate'].textContent.includes('Run search'), 'edited custom requests do not show a stale scenario candidate');
console.log('POC core checks passed: 18 scenarios, synthetic corpus, search modes, scenario-aware preview, highlighting, clarification drafts, top-10/top-50 metrics, and filters.');
