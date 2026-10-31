// @ts-check
/**
 * Loads the existing 18 synthetic demo records into a clearly labelled
 * "synthetic" source. These rows have is_synthetic = 1 and are only ever
 * searched in Demo Mode; Real Data Mode filters them out in SQL.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.mjs';
import { upsertRecord } from '../ingest/pipeline.mjs';

export function seedSyntheticSource(db, tenantId) {
  const existing = db.get("SELECT id FROM sources WHERE tenant_id = ? AND type = 'synthetic'", tenantId);
  const id = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    db.run(`INSERT INTO sources (id, tenant_id, type, name, status, visibility, allowed_roles, config, account_label)
      VALUES (?, ?, 'synthetic', 'Synthetic corpus', 'connected', 'roles', '[]', '{"synthetic": true}', 'Invented records for the demo')`, id, tenantId);
  }
  const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo-corpus.json'), 'utf8'));
  for (const r of corpus.records) {
    upsertRecord(db, { tenantId, sourceId: id, sourceType: 'synthetic', isSynthetic: true }, {
      sourceRecordId: r.id, title: r.title, content: r.text, createdAt: r.date, department: r.department, documentType: r.type,
      keywords: r.terms, threadKey: r.thread ?? null
    });
  }
  db.run("UPDATE sources SET last_sync_at = ?, last_sync_status = 'succeeded' WHERE id = ?", new Date().toISOString(), id);
  return id;
}
