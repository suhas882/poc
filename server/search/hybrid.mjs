// @ts-check
/**
 * Hybrid retrieval over the records the current user may read.
 *
 *   plan → access-controlled candidate filter (tenant, source sharing, record ACL, mode, dates, departments, types, sources)
 *        → BM25 full-text on primary terms  ┐
 *        → BM25 full-text on alternate terms ├→ reciprocal-rank fusion → exclusions → grouping → explanations
 *        → cosine similarity on embeddings  ┘   (only when an embedding provider is configured)
 *
 * Authorization is part of every SQL statement, so records outside the
 * user's permissions are never retrieved, scored or counted.
 */
import { fromBlob, normalize } from '../ingest/pipeline.mjs';

const RRF_K = 60;
const WEIGHTS = { primary: 1.0, alternate: 0.6, semantic: 0.8 };

/**
 * SQL fragment restricting records to what this user may see. Alias r = records, s = sources.
 * @param {{id: string, tenantId: string, role: string}} user @param {'demo' | 'real'} mode
 */
export function accessFilter(user, mode) {
  return {
    sql: `r.tenant_id = ? AND s.tenant_id = ? AND s.status != 'disconnected' AND r.is_synthetic = ?
      AND ((s.visibility = 'owner' AND s.owner_user_id = ?)
        OR (s.visibility = 'roles' AND COALESCE(json_extract(s.config, '$.provider'), '') NOT LIKE 'phonelink%'
          AND (s.allowed_roles = '[]' OR EXISTS (SELECT 1 FROM json_each(s.allowed_roles) WHERE value = ?)))
        -- Phone texts: the employee who owns them, or anyone once the employee sent that item as city business. Sharing never widens this.
        OR (COALESCE(json_extract(s.config, '$.provider'), '') LIKE 'phonelink%'
          AND (s.owner_user_id = ? OR EXISTS (SELECT 1 FROM text_reviews tr WHERE tr.record_id = r.id AND tr.decision = 'city' AND tr.sent_at IS NOT NULL))))
      AND (json_extract(r.access_permissions, '$.roles') IS NULL OR EXISTS (SELECT 1 FROM json_each(r.access_permissions, '$.roles') WHERE value = ?))
      AND (json_extract(r.access_permissions, '$.users') IS NULL OR EXISTS (SELECT 1 FROM json_each(r.access_permissions, '$.users') WHERE value = ?))`,
    params: [user.tenantId, user.tenantId, mode === 'demo' ? 1 : 0, user.id, user.role, user.id, user.role, user.id]
  };
}

/** Plan filters (dates, departments, types, sources) as SQL. */
function planFilter(plan) {
  const parts = [], params = [];
  if (plan.dateFrom) { parts.push('r.created_at >= ?'); params.push(`${plan.dateFrom}T00:00:00.000Z`); }
  if (plan.dateTo) { parts.push('r.created_at <= ?'); params.push(`${plan.dateTo}T23:59:59.999Z`); }
  if (plan.departments?.length && plan.filterDepartments) { parts.push(`(${plan.departments.map(() => 'r.department LIKE ?').join(' OR ')})`); params.push(...plan.departments.map(d => `%${d}%`)); }
  if (plan.recordTypes?.length && plan.filterRecordTypes) { parts.push(`(${plan.recordTypes.map(() => 'r.document_type LIKE ?').join(' OR ')})`); params.push(...plan.recordTypes.map(t => `%${t}%`)); }
  if (plan.sourceIds?.length) { parts.push(`s.id IN (${plan.sourceIds.map(() => '?').join(',')})`); params.push(...plan.sourceIds); }
  // Texts from a phone reach a search only after the employee marked them as city business and sent them for it.
  if (plan.phoneSearchId !== undefined) {
    parts.push(`(COALESCE(json_extract(s.config, '$.provider'), '') NOT LIKE 'phonelink%' OR EXISTS (SELECT 1 FROM text_reviews tr WHERE tr.search_id = ? AND tr.record_id = r.id AND tr.decision = 'city' AND tr.sent_at IS NOT NULL))`);
    params.push(plan.phoneSearchId);
  }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

/** Build a safe FTS5 MATCH expression: every term becomes a quoted phrase, OR-ed together. */
/** Related wording from the city pack's concept groups: a local "meaning" match that never leaves the server. */
export function conceptTerms(terms, concepts = []) {
  const lower = terms.map(t => t.toLowerCase());
  const out = new Map();
  for (const group of concepts) {
    const hit = group.find(c => lower.some(t => t === c || t.includes(c) || c.includes(t)));
    if (hit) for (const c of group) if (!lower.includes(c)) out.set(c, hit);
  }
  return out; // related term -> the plan term it relates to
}

export function ftsQuery(terms) {
  const cleaned = [...new Set(terms.map(t => (String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ')).filter(t => t.length > 1))];
  return cleaned.length ? cleaned.map(t => `"${t}"`).join(' OR ') : '';
}

/** Terms present in a text, matched on word boundaries with simple plural tolerance. */
export function termsIn(text, terms) {
  const lower = text.toLowerCase();
  return [...new Set(terms.filter(t => {
    const esc = t.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return esc && new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(e?s)?(?=$|[^\\p{L}\\p{N}])`, 'iu').test(lower);
  }))];
}

/** Word shingles for near-duplicate detection. */
function shingles(text) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const set = new Set();
  for (let i = 0; i + 4 <= Math.min(words.length, 600); i++) set.add(words.slice(i, i + 4).join(' '));
  return set;
}
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };

/**
 * @param {import('../db.mjs').Database} db
 * @param {{user: {id: string, tenantId: string, role: string}, mode: 'demo' | 'real', plan: any,
 *   embedder?: {model: string, embed: (t: string[], k: 'query') => Promise<number[][]>} | null, limit?: number, requestText?: string,
 *   concepts?: string[][], keywordOnly?: boolean, arguablyBelow?: number}} args
 */
export async function hybridSearch(db, { user, mode, plan, embedder = null, limit = 200, requestText = '', concepts = [], keywordOnly = false, arguablyBelow = 40 }) {
  const started = performance.now();
  const acl = accessFilter(user, mode);
  const pf = planFilter(plan);
  const primaryTerms = [...plan.keywords, ...plan.phrases, ...plan.people, ...plan.organizations, ...plan.locations];
  const related = keywordOnly ? new Map() : conceptTerms([...primaryTerms, ...plan.alternateTerms], concepts);
  const alternateTerms = keywordOnly ? [] : [...new Set([...plan.alternateTerms, ...related.keys()])].filter(t => !primaryTerms.some(p => p.toLowerCase() === t.toLowerCase()));
  /** @type {Map<string, {primary?: number, alternate?: number, semantic?: number, similarity?: number, bestChunk?: number, bm25?: number}>} */
  const ranks = new Map();
  const note = (recordId, list, rank, extra = {}) => {
    const e = ranks.get(recordId) ?? {};
    if (e[list] === undefined || rank < e[list]) { e[list] = rank; Object.assign(e, extra); }
    ranks.set(recordId, e);
  };

  const fts = (terms, list) => {
    const q = ftsQuery(terms);
    if (!q) return 0;
    const rows = db.all(`SELECT c.id AS chunk_id, c.record_id, bm25(chunk_fts, 3.0, 1.0) AS score
      FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid JOIN records r ON r.id = c.record_id JOIN sources s ON s.id = r.source_id
      WHERE chunk_fts MATCH ? AND ${acl.sql}${pf.sql} ORDER BY score LIMIT 600`, q, ...acl.params, ...pf.params);
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.record_id)) continue;
      seen.add(row.record_id);
      note(row.record_id, list, seen.size, list === 'primary' ? { bestChunk: row.chunk_id, bm25: row.score } : {});
    }
    return seen.size;
  };
  const primaryHits = fts(primaryTerms, 'primary');
  const alternateHits = fts(alternateTerms, 'alternate');

  let semanticHits = 0, semanticStatus = embedder ? 'on' : 'off';
  if (embedder && !keywordOnly) {
    try {
      const queryText = [requestText, plan.summary, ...primaryTerms, ...alternateTerms].filter(Boolean).join('\n').slice(0, 4000);
      const [qv] = await embedder.embed([queryText], 'query');
      const q = new Float32Array(normalize(qv));
      const rows = db.all(`SELECT e.chunk_id, e.vector, c.record_id FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
        JOIN records r ON r.id = c.record_id JOIN sources s ON s.id = r.source_id WHERE e.model = ? AND ${acl.sql}${pf.sql}`, embedder.model, ...acl.params, ...pf.params);
      /** @type {Map<string, {sim: number, chunk: number}>} */
      const best = new Map();
      for (const row of rows) {
        const v = fromBlob(row.vector);
        if (v.length !== q.length) continue;
        let sim = 0;
        for (let i = 0; i < v.length; i++) sim += v[i] * q[i];
        const b = best.get(row.record_id);
        if (!b || sim > b.sim) best.set(row.record_id, { sim, chunk: row.chunk_id });
      }
      [...best.entries()].filter(([, b]) => b.sim >= 0.2).sort((a, b) => b[1].sim - a[1].sim).slice(0, 300)
        .forEach(([id, b], i) => note(id, 'semantic', i + 1, { similarity: b.sim, ...(ranks.get(id)?.bestChunk ? {} : { bestChunk: b.chunk }) }));
      semanticHits = best.size;
    } catch (err) {
      semanticStatus = 'error';
    }
  }

  if (!ranks.size) return { results: [], stats: { primaryHits, alternateHits, semanticHits, semanticStatus, durationMs: Math.round(performance.now() - started), excluded: 0 } };

  // Load candidates (already authorised by the queries above).
  const ids = [...ranks.keys()];
  const records = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const slice = ids.slice(i, i + 400);
    for (const r of db.all(`SELECT r.*, s.name AS source_name FROM records r JOIN sources s ON s.id = r.source_id WHERE r.id IN (${slice.map(() => '?').join(',')})`, ...slice)) records.set(r.id, r);
  }

  const exclusions = plan.exclusions || [];
  let excluded = 0;
  const scored = [];
  for (const [id, e] of ranks) {
    const r = records.get(id);
    if (!r) continue;
    const haystack = `${r.title}\n${r.content}`;
    if (exclusions.length && termsIn(haystack, exclusions).length) { excluded++; continue; }
    let score = 0;
    if (e.primary) score += WEIGHTS.primary / (RRF_K + e.primary);
    if (e.alternate) score += WEIGHTS.alternate / (RRF_K + e.alternate);
    if (e.semantic) score += WEIGHTS.semantic / (RRF_K + e.semantic);
    const exact = termsIn(haystack, primaryTerms);
    const alt = termsIn(haystack, alternateTerms);
    const inTitle = termsIn(r.title, primaryTerms);
    score += inTitle.length * 0.002;
    const peopleHit = termsIn(`${r.sender || ''} ${r.recipients}`, plan.people || []);
    score += peopleHit.length * 0.002;
    const deptHit = (plan.departments || []).some(d => r.department && r.department.toLowerCase().includes(d.toLowerCase()));
    const typeHit = (plan.recordTypes || []).some(t => r.document_type && r.document_type.toLowerCase().includes(t.toLowerCase()));
    if (deptHit) score += 0.0015;
    if (typeHit) score += 0.0015;
    const matchType = exact.length ? 'exact' : alt.length ? 'alternate' : 'semantic';
    scored.push({ r, e, score, exact, alt, inTitle, peopleHit, matchType, deptHit, typeHit });
  }
  scored.sort((a, b) => b.score - a.score || String(b.r.created_at).localeCompare(String(a.r.created_at)));
  const top = scored.slice(0, limit);
  const max = top[0]?.score || 1;

  // Grouping: exact duplicates, same thread/conversation, and near-duplicates.
  const groupOf = new Map();
  const sh = new Map();
  for (const item of top) {
    const r = item.r;
    let key = r.duplicate_of ? `dup:${r.duplicate_of}` : r.thread_key ? `thread:${r.thread_key}` : null;
    if (!key) {
      const mine = shingles(r.content.slice(0, 4000));
      sh.set(r.id, mine);
      for (const [otherId, other] of sh) if (otherId !== r.id && jaccard(mine, other) >= 0.85) { key = groupOf.get(otherId) || `near:${otherId}`; break; }
    }
    if (r.duplicate_of && !groupOf.has(r.duplicate_of)) groupOf.set(r.duplicate_of, key);
    groupOf.set(r.id, key);
  }

  const results = top.map((item, i) => {
    const { r, e } = item;
    const chunk = e.bestChunk ? db.get('SELECT text, start_offset FROM chunks WHERE id = ?', e.bestChunk) : null;
    const relevance = Math.round((item.score / max) * 100);
    const reasons = [];
    if (item.exact.length) reasons.push(`Contains ${item.exact.slice(0, 4).map(t => `“${t}”`).join(', ')}`);
    if (item.inTitle.length) reasons.push('A search term is in the title');
    const viaMeaning = item.alt.filter(t => related.has(t));
    if (viaMeaning.length) reasons.push(`Matches “${related.get(viaMeaning[0])}” by meaning (uses ${viaMeaning.slice(0, 3).map(t => `“${t}”`).join(', ')})`);
    const plainAlt = item.alt.filter(t => !related.has(t));
    if (plainAlt.length) reasons.push(`Uses related wording: ${plainAlt.slice(0, 3).map(t => `“${t}”`).join(', ')}`);
    if (e.similarity !== undefined) reasons.push(`Similar in meaning (similarity ${e.similarity.toFixed(2)})`);
    if (item.peopleHit.length) reasons.push(`Involves ${item.peopleHit.join(', ')}`);
    if (item.deptHit) reasons.push(`From ${r.department}, a department in the plan`);
    if (item.typeHit) reasons.push(`Is a ${String(r.document_type).toLowerCase()}, a record type in the plan`);
    if ((plan.dateFrom || plan.dateTo) && r.created_at) reasons.push(`Dated ${r.created_at.slice(0, 10)}, inside the requested period`);
    const passageTerms = [...item.exact, ...item.alt];
    const passage = snippetAround(chunk?.text || r.content, passageTerms, 240);
    // Every reason must point at a passage in the record; a result without one is dropped.
    if (!passage || !reasons.length) return null;
    const why = `${reasons[0]}${reasons[1] ? `. ${reasons[1]}` : ''}.`;
    return {
      recordId: r.id, rank: 0, score: item.score, groupKey: groupOf.get(r.id) || null,
      match: {
        relevance, band: relevance >= 70 ? 'strong' : relevance >= arguablyBelow ? 'possible' : 'weak', arguable: relevance < arguablyBelow,
        matchType: item.exact.length ? 'exact' : viaMeaning.length ? 'meaning' : item.alt.length ? 'alternate' : 'semantic',
        exactTerms: item.exact, alternateTerms: item.alt, similarity: e.similarity ?? null,
        signals: { primaryRank: e.primary ?? null, alternateRank: e.alternate ?? null, semanticRank: e.semantic ?? null },
        why, reasons, snippet: passage, passageRef: { recordId: r.id, chunkId: e.bestChunk ?? null }
      }
    };
  }).filter(Boolean).map((x, i) => ({ ...x, rank: i + 1 }));
  return { results, stats: { primaryHits, alternateHits, semanticHits, semanticStatus, durationMs: Math.round(performance.now() - started), excluded } };
}

/** ~320 characters around the first matching term. */
export function snippetAround(text, terms, size = 320) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= size) return clean;
  const lower = clean.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = lower.indexOf(t.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = Math.max(0, at < 0 ? 0 : at - Math.floor(size / 3));
  const s = clean.slice(start, start + size);
  return (start > 0 ? '…' : '') + s + (start + size < clean.length ? '…' : '');
}
