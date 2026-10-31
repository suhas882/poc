// @ts-check
/**
 * Parsers for message exports the user creates themselves. There is no
 * device access: Android and iOS do not let a web service read SMS, and
 * WhatsApp/iMessage have no API for reading someone's chats. Supported inputs:
 *  - "SMS Backup & Restore" XML (Android): <smses><sms address date type body contact_name/></smses>
 *  - WhatsApp "Export chat" .txt (Android and iOS formats)
 *  - Generic CSV with columns: date, from, to, body (optional: conversation)
 * Messages are grouped into one record per conversation per day.
 */
import { decodeXml } from './zip.mjs';
import { decodeText, parseCsv } from './extract.mjs';

/** @typedef {{at: string | null, from: string, to: string, body: string, conversation: string}} Message */

export function detectMessageFormat(filename, buf) {
  const head = decodeText(buf.subarray(0, 4096));
  if (/<smses\b/i.test(head) || /<sms\b/i.test(head)) return 'sms-backup-xml';
  if (/\.csv$/i.test(filename)) return 'csv';
  if (/^\[?\d{1,4}[./-]\d{1,2}[./-]\d{1,4},? \d{1,2}:\d{2}/m.test(head)) return 'whatsapp-txt';
  return null;
}

/** @returns {Message[]} */
export function parseSmsBackupXml(text) {
  const out = [];
  for (const m of text.matchAll(/<sms\b([^>]*?)\/?>/g)) {
    const a = (name) => { const r = new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]); return r ? decodeXml(r[1]) : ''; };
    const address = a('address');
    const contact = a('contact_name');
    const who = contact && contact !== '(Unknown)' ? `${contact} (${address})` : address;
    const sent = a('type') === '2';
    const ms = Number(a('date'));
    out.push({ at: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null, from: sent ? 'Me' : who, to: sent ? who : 'Me', body: a('body'), conversation: who || 'Unknown' });
  }
  return out;
}

/** WhatsApp: "12/03/2025, 14:05 - Name: text" (Android) or "[12/03/2025, 14:05:09] Name: text" (iOS). */
export function parseWhatsAppTxt(text, { dayFirst = true, conversation = 'WhatsApp chat' } = {}) {
  const re = /^‎?\[?(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\]?\s*(?:-\s*)?([^:]{1,80}): (.*)$/;
  /** @type {Message[]} */
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) {
      let [, a, b, c, hh, mm, ss, ampm, from, body] = m;
      let year = Number(c), month = Number(dayFirst ? b : a), day = Number(dayFirst ? a : b);
      if (a.length === 4) { year = Number(a); month = Number(b); day = Number(c); }
      if (year < 100) year += 2000;
      let hour = Number(hh);
      if (ampm) { const pm = /p/i.test(ampm); if (pm && hour < 12) hour += 12; if (!pm && hour === 12) hour = 0; }
      const d = new Date(Date.UTC(year, month - 1, day, hour, Number(mm), Number(ss || 0)));
      out.push({ at: Number.isNaN(d.getTime()) ? null : d.toISOString(), from: from.trim(), to: '', body, conversation });
    } else if (out.length && line.trim()) {
      out[out.length - 1].body += '\n' + line; // continuation of a multi-line message
    }
  }
  return out;
}

export function parseMessageCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = (...names) => header.findIndex(h => names.includes(h));
  const iDate = col('date', 'timestamp', 'time', 'sent_at'), iFrom = col('from', 'sender'), iTo = col('to', 'recipient', 'recipients'), iBody = col('body', 'message', 'text', 'content'), iConv = col('conversation', 'thread', 'chat');
  if (iBody < 0) throw new Error('The CSV needs a "body" (or "message") column.');
  return rows.slice(1).map(r => {
    const t = iDate >= 0 ? Date.parse(r[iDate]) : NaN;
    return { at: Number.isNaN(t) ? null : new Date(t).toISOString(), from: iFrom >= 0 ? r[iFrom] : '', to: iTo >= 0 ? r[iTo] : '', body: r[iBody] ?? '', conversation: (iConv >= 0 ? r[iConv] : '') || (iFrom >= 0 ? r[iFrom] : '') || 'Messages' };
  });
}

/**
 * @param {string} filename @param {Buffer} buf
 * @returns {{format: string, messages: Message[]}}
 */
export function parseMessages(filename, buf) {
  const format = detectMessageFormat(filename, buf);
  const text = decodeText(buf);
  if (format === 'sms-backup-xml') return { format, messages: parseSmsBackupXml(text) };
  if (format === 'csv') return { format, messages: parseMessageCsv(text) };
  if (format === 'whatsapp-txt') return { format, messages: parseWhatsAppTxt(text, { conversation: filename.replace(/\.txt$/i, '').replace(/^WhatsApp Chat with /i, '') || 'WhatsApp chat' }) };
  throw new Error('This file is not a supported message export. Use an SMS Backup & Restore XML file, a WhatsApp "Export chat" .txt file, or a CSV with date, from, to and body columns.');
}

/** Group messages into one record per conversation per day. */
export function groupConversations(messages, sourceLabel) {
  /** @type {Map<string, Message[]>} */
  const groups = new Map();
  for (const m of messages) {
    if (!m.body.trim()) continue;
    const day = m.at ? m.at.slice(0, 10) : 'undated';
    const key = `${m.conversation}|${day}`;
    (groups.get(key) ?? groups.set(key, []).get(key))?.push(m);
  }
  return [...groups.entries()].map(([key, msgs]) => {
    const [conversation, day] = key.split('|');
    msgs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const participants = [...new Set(msgs.flatMap(m => [m.from, m.to]).filter(Boolean))];
    return {
      sourceRecordId: key,
      title: `${sourceLabel}: ${conversation}, ${day === 'undated' ? 'undated' : day}`,
      content: msgs.map(m => `[${m.at ? m.at.slice(11, 16) : '--:--'}] ${m.from || 'Unknown'}: ${m.body}`).join('\n'),
      sender: msgs[0].from || null,
      recipients: participants,
      createdAt: msgs[0].at,
      modifiedAt: msgs[msgs.length - 1].at,
      documentType: 'Message conversation',
      threadKey: `conv:${conversation}`
    };
  });
}
