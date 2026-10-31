// @ts-check
/**
 * City packs hold everything city-specific (departments, record types, unconnected sources, holidays, wording,
 * review rules, broad-plan warning level, source map), so nothing is hard-coded to one city.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { parseJson } from './db.mjs';

const DIR = path.join(ROOT, 'packs');
const cache = new Map();

export function listPacks() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => loadPack(f.replace(/\.json$/, ''))).map(p => ({ id: p.id, name: p.name, label: p.label }));
}

export function loadPack(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('bad pack id');
  if (!cache.has(id)) cache.set(id, Object.freeze(JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'))));
  return cache.get(id);
}

export const getSetting = (db, tenantId, key, fallback = null) => parseJson(db.get('SELECT value FROM settings WHERE tenant_id = ? AND key = ?', tenantId, key)?.value, fallback);
export const setSetting = (db, tenantId, key, value) => db.run('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value', tenantId, key, JSON.stringify(value));

/** The active pack for a tenant, with Settings overrides applied (holidays, warning level). */
export function activePack(db, tenantId) {
  let id = getSetting(db, tenantId, 'pack', 'bellevue');
  let pack;
  try { pack = loadPack(id); } catch { pack = loadPack('bellevue'); id = 'bellevue'; }
  const added = getSetting(db, tenantId, 'holidays_added', []);
  const removed = new Set(getSetting(db, tenantId, 'holidays_removed', []));
  const holidays = [...new Set([...pack.holidays, ...added])].filter(d => !removed.has(d)).sort();
  const threshold = getSetting(db, tenantId, 'broad_threshold', null);
  return { ...pack, id, holidays, holidaysAdded: added, holidaysRemoved: [...removed], broadPlanThreshold: Number.isInteger(threshold) ? threshold : pack.broadPlanThreshold };
}

/** Admin switches. Real sources are set by the server environment only; the UI can never turn them on. */
export function switches(db, tenantId, config) {
  return {
    realSources: config.realSources,
    phoneLink: config.realSources && getSetting(db, tenantId, 'switch_phonelink', false) === true,
    secondApproval: getSetting(db, tenantId, 'switch_approval', false) === true
  };
}
