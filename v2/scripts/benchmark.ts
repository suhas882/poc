/** Run the keyword vs synonym-expanded benchmark over all 18 scenarios. `npm run benchmark` */
import { writeFileSync } from 'node:fs';
import { runFullEvaluation } from '../src/lib/evaluation';

const result = runFullEvaluation();
writeFileSync('benchmark-results.json', JSON.stringify(result, null, 2));
for (const [type, g] of Object.entries(result.groups)) {
  console.log(`${type}: recall@10 keyword ${g.keyword.recallAt10}% vs hybrid ${g.hybrid.recallAt10}% · precision@10 ${g.keyword.precisionAt10}% vs ${g.hybrid.precisionAt10}%`);
}
console.log('Synthetic results only. Saved benchmark-results.json');
