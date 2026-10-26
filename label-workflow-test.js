const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const values = {
  'label-scenario': {value:'syn-1',innerHTML:''},
  'label-role': {value:'reviewer1'},
  'label-table': {innerHTML:''},
  'label-progress': {textContent:''},
  'export-labels': {onclick:null}
};
const select = {dataset:{record:'R-001'},value:'',onchange:null};
const saved = new Map();
const document = {
  getElementById:id=>values[id]||{value:'',innerHTML:'',textContent:'',hidden:false},
  querySelectorAll:selector=>selector==='.label-choice'?[select]:[],
  addEventListener:()=>{}
};
const context = vm.createContext({document,console,Date,Set,Map,localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)}});
vm.runInContext(fs.readFileSync('app.js','utf8'),context);
vm.runInContext('initLabelReview()',context);
assert.equal((values['label-table'].innerHTML.match(/<tr>/g)||[]).length,19,'label view has one header and all 18 records');
assert(values['label-table'].innerHTML.includes('Hidden during reviewer entry'),'reviewers do not see the provisional labels');
select.value='relevant'; select.onchange();
values['label-role'].value='reviewer2'; vm.runInContext('renderLabelWorksheet()',context);
select.value='not relevant'; select.onchange();
values['label-role'].value='adjudicator'; vm.runInContext('renderLabelWorksheet()',context);
assert(values['label-table'].innerHTML.includes('Difference'),'adjudicator view flags label differences');
assert(values['label-table'].innerHTML.includes('Provisional example label'),'adjudicator can compare the example label separately');
assert(saved.has('synthetic-label-votes'),'labels persist in browser-local storage');
console.log('Label workflow checks passed: separate reviewer views, provisional-label hiding, persistence, and adjudication differences.');
