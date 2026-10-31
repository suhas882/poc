// Keyword-only versus hybrid on the labeled test set (invented requests over the synthetic corpus).
// Writes benchmark-results.json. Demo results on invented data, not production performance.
import fs from 'node:fs';
import { startApp } from '../tests/helpers.mjs';

const env = await startApp({ REAL_SOURCES: 'false' });
const c = env.client();
const d = await c.post('/api/auth/demo', { role: 'records_officer' });
c.csrf = d.data.data.csrfToken;
const bench = (await c.get('/api/evaluation/benchmark')).data.data;
const replay = (await c.get('/api/evaluation/replay')).data.data;
await env.close();
const out = { generatedAt: new Date().toISOString(), note: bench.banner, keyword: bench.keyword, hybrid: bench.hybrid, kinds: bench.kinds, labels: bench.labels,
  replay: replay.requests.map(r => ({ id: r.id, label: r.label, released: r.released, inTop50: r.inTop50, recall: r.recall, keywordRecall: r.keywordRecall, missed: r.missed.map(m => m.corpusId) })) };
fs.writeFileSync(new URL('../benchmark-results.json', import.meta.url), JSON.stringify(out, null, 2));
const pct = (x) => `${Math.round(x * 100)}%`;
console.log(`Keyword only: recall@10 ${pct(bench.keyword.recall10)}, recall@50 ${pct(bench.keyword.recall50)}, precision@10 ${pct(bench.keyword.precision10)}`);
console.log(`Hybrid:       recall@10 ${pct(bench.hybrid.recall10)}, recall@50 ${pct(bench.hybrid.recall50)}, precision@10 ${pct(bench.hybrid.precision10)}`);
console.log(bench.banner);
