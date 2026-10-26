const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({
  document: { getElementById: () => ({ value: '' }), querySelectorAll: () => [], addEventListener: () => {} },
  console, Date, Set, Map, performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }
});
vm.runInContext(fs.readFileSync('app.js', 'utf8'), context);
const scenarios = JSON.parse(vm.runInContext('JSON.stringify(scenarios)', context));
const run = (s, mode) => {
  const fields = {topics:s.topics, 'alternate-terms':s.alternate || '', 'people-orgs':'', 'date-filter':s.date || '', 'department-filter':'', 'record-filter':'', exclusions:''};
  context.document.getElementById = id => ({value: fields[id] ?? ''});
  vm.runInContext(`currentScenario=scenarios.find(s=>s.id===${JSON.stringify(s.id)})`, context);
  const t0 = process.hrtime.bigint();
  const rows = JSON.parse(vm.runInContext(`JSON.stringify(rank(${JSON.stringify(mode)}).map(x=>({id:x.record.id})))`, context));
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  const relevant = new Set(s.relevant), metrics = {};
  for (const k of [10,50]) {
    const top = rows.slice(0,k), hits = top.filter(x=>relevant.has(x.id)).length;
    metrics[`recall_at_${k}`] = Number((hits/relevant.size*100).toFixed(1));
    metrics[`precision_at_${k}`] = Number((hits/Math.min(k,18)*100).toFixed(1));
  }
  const first = rows.findIndex(x=>relevant.has(x.id));
  return { ...metrics, first_relevant_rank:first<0?null:first+1, time_to_first_relevant_ms:first<0?null:Number(elapsed.toFixed(3)), ranking_time_ms:Number(elapsed.toFixed(3)) };
};
const result = {notice:'Synthetic-only benchmark. Metrics are target outcomes to be validated during discovery. Timing is local ranking time, not staff time.', corpus_size:18, scenario_count:scenarios.length, scenarios:scenarios.map(s=>({id:s.id,type:s.type,keyword:run(s,'keyword'),synonym_expanded:run(s,'hybrid')}))};
for (const type of ['Exact keyword','Different wording','Vague request']) {
  const rows=result.scenarios.filter(s=>scenarios.find(x=>x.id===s.id).type===type);
  result[type]={count:rows.length};
  for (const method of ['keyword','synonym_expanded']) for (const metric of ['recall_at_10','precision_at_10','recall_at_50','precision_at_50']) result[type][`${method}_${metric}`]=Number((rows.reduce((a,r)=>a+r[method][metric],0)/rows.length).toFixed(1));
}
console.log(JSON.stringify(result,null,2));
