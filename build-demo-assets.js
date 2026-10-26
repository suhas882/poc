const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({
  document: { getElementById: () => ({ value: '' }), querySelectorAll: () => [], addEventListener: () => {} },
  console, Date, Set, Map
});
vm.runInContext(fs.readFileSync('app.js', 'utf8'), context);
const records = JSON.parse(vm.runInContext('JSON.stringify(records)', context));
const scenarios = JSON.parse(vm.runInContext('JSON.stringify(scenarios)', context));
const corpus = {
  title: 'Synthetic public-records search corpus',
  created_at: '2026-10-26',
  mode: 'synthetic',
  notice: 'All documents are invented for this prototype. No Bellevue or other public documents were downloaded.',
  records: records.map(r => ({ ...r, source_url: null, retrieved_at: null, synthetic: true }))
};
fs.writeFileSync('demo-corpus.json', JSON.stringify(corpus, null, 2) + '\n');
fs.writeFileSync('demo-requests.json', JSON.stringify({
  notice: 'All request scenarios and provisional relevance labels are invented. Human review is not complete.',
  scenarios
}, null, 2) + '\n');
console.log(`Wrote ${records.length} synthetic records and ${scenarios.length} invented scenarios.`);
