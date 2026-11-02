import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startApp, searchReq } from './helpers.mjs';

/** A stand-in for ClamAV's clamd that speaks INSTREAM: length-prefixed chunks, a zero-length chunk ends the stream. */
async function fakeClamd() {
  const seen = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const cmd = 'zINSTREAM\0';
      if (buf.length < cmd.length) return;
      let off = cmd.length; const body = [];
      while (buf.length >= off + 4) {
        const n = buf.readUInt32BE(off);
        if (n === 0) {
          const file = Buffer.concat(body).toString('latin1');
          seen.push(file);
          sock.end(file.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buf.length < off + 4 + n) return;
        body.push(buf.subarray(off + 4, off + 4 + n)); off += 4 + n;
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise(r => server.close(r)) };
}

test('JSON uploads: values are searchable with their field names; invalid JSON is refused', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client(); await c.setup();
  const doc = { case: 'PR-2025-114', requests: [{ street: 'Cedar Avenue', topic: 'lane closure', status: 'open' }], owner: { department: 'Transportation' } };
  let r = await c.upload('requests-export.json', Buffer.from(JSON.stringify(doc)));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.data.scan, 'not_scanned', 'no scanner configured on this server');
  const rec = (await c.get(`/api/records/${r.data.data.recordId}`)).data.data;
  assert.match(rec.content, /requests\.0\.street: Cedar Avenue/);
  assert.equal(rec.documentType, 'JSON');
  const sr = await searchReq(c, 'Cedar Avenue lane closure', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  assert(sr.results.some(x => x.record.id === r.data.data.recordId));
  r = await c.upload('broken.json', Buffer.from('{"case": "PR-1", '));
  assert.equal(r.status, 422); assert.match(r.data.error.message, /not valid JSON/);
});

test('malware scanning: infected uploads are refused and audited; clean ones record the scan; a required scanner that is down refuses uploads', async (t) => {
  const clam = await fakeClamd();
  t.after(() => clam.close());
  const env = await startApp({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clam.port) });
  t.after(() => env.close());
  const c = env.client(); await c.setup();

  let r = await c.upload('memo.txt', Buffer.from('Cedar Avenue memo, clean text.'));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.data.scan, 'clean');
  assert.equal(clam.seen.at(-1), 'Cedar Avenue memo, clean text.', 'the scanner received the exact bytes');

  const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  r = await c.upload('invoice.txt', Buffer.from(eicar));
  assert.equal(r.status, 422); assert.equal(r.data.error.code, 'malware_found');
  assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM records WHERE title = 'invoice.txt'").n, 0, 'nothing from the infected file is stored');
  r = await c.upload('sms.xml', Buffer.from(`<smses><sms address="1" date="1737360000000" type="1" body="${eicar}" /></smses>`), '?kind=messages');
  assert.equal(r.status, 422, 'message exports are scanned too');
  const rejected = (await c.get('/api/audit?pageSize=200')).data.data.filter(a => a.action === 'upload.rejected');
  assert.equal(rejected.length, 2);

  // Scanner required but unreachable: uploads are refused instead of passing unscanned.
  const strict = await startApp({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '1', CLAMAV_REQUIRED: 'true', CLAMAV_TIMEOUT_MS: '2000' });
  t.after(() => strict.close());
  const s = strict.client(); await s.setup();
  r = await s.upload('memo.txt', Buffer.from('hello'));
  assert.equal(r.status, 503); assert.equal(r.data.error.code, 'scanner_unavailable');
  // Not required: the upload goes through and is marked as not scanned.
  const lax = await startApp({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '1', CLAMAV_TIMEOUT_MS: '2000' });
  t.after(() => lax.close());
  const l = lax.client(); await l.setup();
  r = await l.upload('memo.txt', Buffer.from('hello'));
  assert.equal(r.status, 201); assert.equal(r.data.data.scan, 'not_scanned');
});
