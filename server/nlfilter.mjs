// @ts-check
/**
 * Plain-language result filters ("emails from Transportation in February") parsed into visible, removable chips.
 * Runs locally on the typed filter text only. It never sees record content.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const TYPE_WORDS = [[/\be-?mails?\b/i, 'Email'], [/\bmemos?\b/i, 'Memo'], [/\bpermits?\b/i, 'Permit'], [/\bnotices?\b/i, 'Notice'], [/\bcontracts?\b/i, 'Contract'],
  [/\bminutes\b/i, 'Meeting minutes'], [/\breports?\b/i, 'Report'], [/\b(texts?|sms)\b/i, 'Text'], [/\bcomplaints?\b/i, 'Complaint'], [/\bspreadsheets?\b/i, 'Spreadsheet'], [/\binspections?\b/i, 'Inspection']];
const MARK_WORDS = [[/\b(not yet marked|unmarked|not marked)\b/i, 'none', 'Not yet marked'], [/\bnot relevant\b/i, 'not_relevant', 'Not relevant'], [/\bunsure\b/i, 'unsure', 'Unsure'], [/\b(?<!not )relevant\b/i, 'relevant', 'Relevant']];

const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);

export function parseFilter(text, { departments = [], recordTypes = [], sources = [], year = new Date().getUTCFullYear() } = {}) {
  const t = text.trim();
  const chips = [];
  let rest = t;
  for (const [re, value] of TYPE_WORDS) if (re.test(t)) { chips.push({ kind: 'type', value, label: `Type: ${value.toLowerCase()}` }); rest = rest.replace(re, ' '); break; }
  for (const d of [...departments].sort((a, b) => b.length - a.length)) {
    const short = d.split(/[ &,]/)[0];
    if (new RegExp(`\\b${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t) || (short.length > 4 && new RegExp(`\\b${short}\\b`, 'i').test(t))) { chips.push({ kind: 'department', value: d, label: `Dept: ${d}` }); break; }
  }
  for (const s of sources) if (s.name && new RegExp(`\\b${s.name.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t) && !/^(synthetic)$/i.test('')) { chips.push({ kind: 'source', value: s.id, label: `Source: ${s.name}` }); break; }
  const m = new RegExp(`\\b(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\b\\s*(\\d{4})?`, 'i').exec(t);
  if (m) {
    const mi = MONTHS.findIndex(x => x.startsWith(m[1].slice(0, 3).toLowerCase()));
    const y = Number(m[2] || year);
    chips.push({ kind: 'date', from: `${y}-${String(mi + 1).padStart(2, '0')}-01`, to: lastDay(y, mi), label: `${MONTHS[mi][0].toUpperCase()}${MONTHS[mi].slice(1, 3)} ${y}` });
  } else {
    const y = /\b(?:in|during|from)\s+(\d{4})\b/i.exec(t);
    if (y) chips.push({ kind: 'date', from: `${y[1]}-01-01`, to: `${y[1]}-12-31`, label: y[1] });
  }
  for (const [re, value, label] of MARK_WORDS) if (re.test(t)) { chips.push({ kind: 'mark', value, label: `Mark: ${label}` }); break; }
  void recordTypes;
  return { text: t, chips, understood: chips.length > 0 };
}
