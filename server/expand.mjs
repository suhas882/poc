// @ts-check
/**
 * "Expand from what you found": suggest terms that appear in records staff marked relevant but are not in the plan.
 * Runs on this server over local record text. Nothing is sent to a model. Nothing is added without approval.
 */
const STOP = new Set('a an and are as at be been but by can could do for from had has have he her his i if in into is it its may more most no not of on or our out over said she should so some such than that the their them then there these they this those to up us was we were what when which while who will with would you your about after also any been before both each few other only own same too very just per via within without upon across against among during including following city staff please thanks regards project work'.split(' '));

const words = (text) => (text.toLowerCase().match(/[a-z][a-z-]{2,}/g) || []).filter(w => !STOP.has(w));

/** @param {{id: string, title: string, content: string}[]} records @param {any} plan */
export function suggestTerms(records, plan = {}, concepts = []) {
  const inPlan = new Set([...(plan.keywords || []), ...(plan.alternateTerms || []), ...(plan.phrases || []), ...(plan.people || []), ...(plan.organizations || []), ...(plan.locations || [])].map(t => t.toLowerCase()));
  const planWords = new Set([...inPlan].flatMap(t => t.split(/\s+/)));
  /** @type {Map<string, {term: string, kind: string, recordIds: Set<string>}>} */
  const found = new Map();
  const add = (term, kind, id) => {
    const key = term.toLowerCase();
    if (inPlan.has(key) || key.length < 3) return;
    const e = found.get(key) ?? { term, kind, recordIds: new Set() };
    e.recordIds.add(id);
    found.set(key, e);
  };
  for (const r of records) {
    const text = `${r.title}\n${r.content}`;
    for (const code of text.match(/\b[A-Z]{1,5}-\d{2,6}\b|\b[A-Z]{2,5}\d{2,6}\b/g) || []) add(code, 'Project code', r.id);
    for (const name of text.match(/\b(?:[A-Z][a-z]+\s){1,2}[A-Z][a-z]+\b/g) || []) {
      if (/^(The|This|That|Please|City|Public|North|South|East|West)\b/.test(name)) continue;
      add(name, /\b(Avenue|Street|Road|Way|Park|Boulevard|Drive|Place)\b/.test(name) ? 'Place named' : 'Person named', r.id);
    }
    // Alternate wording: related terms from the city pack found in this record, plus phrases shared by several relevant records.
    const lower = text.toLowerCase();
    for (const c of concepts.flat()) if (new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`).test(lower)) add(c, 'Alternate wording', r.id);
    const ws = words(text);
    for (let i = 0; i + 1 < ws.length; i++) {
      const bi = `${ws[i]} ${ws[i + 1]}`;
      if (!planWords.has(ws[i]) || !planWords.has(ws[i + 1])) add(bi, 'Shared phrase', r.id);
    }
  }
  return [...found.values()]
    .filter(x => x.kind !== 'Shared phrase' || x.recordIds.size >= 2)
    .map(x => x.kind === 'Shared phrase' ? { ...x, kind: 'Alternate wording' } : x)
    .map(x => ({ term: x.term, kind: x.kind, count: x.recordIds.size, recordIds: [...x.recordIds], example: records.find(r => x.recordIds.has(r.id)) }))
    .map(x => ({ ...x, example: x.example ? { id: x.example.id, title: x.example.title } : null }))
    .sort((a, b) => b.count - a.count || (a.kind === 'Project code' ? -1 : 0) || a.term.localeCompare(b.term))
    .slice(0, 12);
}
