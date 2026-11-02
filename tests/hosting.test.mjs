import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forwardedIp } from '../server/app.mjs';
import { Database } from '../server/db.mjs';

test('forwardedIp: last proxy entry, with Azure App Service style ports removed', () => {
  assert.equal(forwardedIp('203.0.113.7:51234'), '203.0.113.7', 'App Service adds the client port');
  assert.equal(forwardedIp('10.0.0.1, 203.0.113.7:443'), '203.0.113.7', 'only the entry our proxy added counts');
  assert.equal(forwardedIp('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(forwardedIp('2001:db8::1'), '2001:db8::1', 'bare IPv6 is left alone');
  assert.equal(forwardedIp('198.51.100.2'), '198.51.100.2');
  assert.equal(forwardedIp(''), '');
  assert.equal(forwardedIp(undefined), '');
});

test('SQLITE_JOURNAL_MODE: WAL by default, DELETE for network storage such as App Service /home', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prs-journal-'));
  const before = process.env.SQLITE_JOURNAL_MODE;
  try {
    delete process.env.SQLITE_JOURNAL_MODE;
    const a = new Database(path.join(dir, 'a.db'));
    assert.equal(a.get('PRAGMA journal_mode').journal_mode, 'wal');
    process.env.SQLITE_JOURNAL_MODE = 'delete';
    const b = new Database(path.join(dir, 'b.db'));
    assert.equal(b.get('PRAGMA journal_mode').journal_mode, 'delete');
    assert.equal(b.get('PRAGMA synchronous').synchronous, 2, 'FULL sync without WAL');
    process.env.SQLITE_JOURNAL_MODE = 'MEMORY; DROP TABLE x';
    const c = new Database(path.join(dir, 'c.db'));
    assert.equal(c.get('PRAGMA journal_mode').journal_mode, 'wal', 'anything else falls back to WAL; nothing is injected');
    a.db.close(); b.db.close(); c.db.close();
  } finally {
    if (before === undefined) delete process.env.SQLITE_JOURNAL_MODE; else process.env.SQLITE_JOURNAL_MODE = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
