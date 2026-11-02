// @ts-check
/**
 * Optional malware scanning of uploads with ClamAV's clamd daemon (INSTREAM over TCP). Files are scanned before
 * they are parsed or stored. Without CLAMAV_HOST nothing is scanned and each upload is marked "not scanned".
 * With CLAMAV_REQUIRED=true an unreachable scanner refuses the upload instead of letting it through.
 */
import net from 'node:net';
import { HttpError } from '../http.mjs';

/** @typedef {{status: 'clean' | 'not_scanned', engine: string | null}} ScanResult */

/** @param {Buffer} buf @param {{host: string, port: number, timeoutMs: number}} cfg @returns {Promise<string>} clamd's reply line */
export function clamdInstream(buf, cfg) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: cfg.host, port: cfg.port });
    let reply = '';
    sock.setTimeout(cfg.timeoutMs, () => sock.destroy(new Error('The virus scanner did not answer in time.')));
    sock.on('error', reject);
    sock.on('data', (d) => { reply += d.toString('utf8'); });
    sock.on('end', () => resolve(reply.replace(/\0/g, '').trim()));
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buf.length; i += 64 * 1024) {
        const chunk = buf.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length);
        sock.write(len); sock.write(chunk);
      }
      sock.end(Buffer.alloc(4)); // zero-length chunk ends the stream
    });
  });
}

/**
 * @param {Buffer} buf
 * @param {{host: string, port: number, required: boolean, timeoutMs: number}} cfg
 * @returns {Promise<ScanResult>} throws 422 for an infected file, 503 when scanning is required but unavailable
 */
export async function scanUpload(buf, cfg) {
  if (!cfg.host) return { status: 'not_scanned', engine: null };
  let reply;
  try { reply = await clamdInstream(buf, cfg); } catch (err) {
    if (cfg.required) throw new HttpError(503, 'scanner_unavailable', 'The virus scanner is not reachable, and this server requires every upload to be scanned. Try again later or contact an administrator.');
    return { status: 'not_scanned', engine: 'clamav (unreachable)' };
  }
  // "stream: OK" or "stream: Eicar-Signature FOUND"
  const found = /:\s*(.+)\s+FOUND$/.exec(reply);
  if (found) throw new HttpError(422, 'malware_found', `The virus scanner flagged this file (${found[1].slice(0, 100)}), so it was not added.`, { signature: found[1].slice(0, 100) });
  if (!/:\s*OK$/.test(reply)) {
    if (cfg.required) throw new HttpError(503, 'scanner_error', 'The virus scanner could not check this file, and this server requires every upload to be scanned.');
    return { status: 'not_scanned', engine: 'clamav (error)' };
  }
  return { status: 'clean', engine: 'clamav' };
}
