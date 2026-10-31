// @ts-check
/**
 * Response clock: N business days after receipt (the day of receipt does not count), skipping weekends and the
 * holidays in the active city pack plus any added in Settings. Dates are plain YYYY-MM-DD in the city's time zone.
 */

const DAY = 86_400_000;
const toUtc = (d) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const isBusinessDay = (d, holidays) => { const wd = new Date(toUtc(d)).getUTCDay(); return wd !== 0 && wd !== 6 && !holidays.has(d); };

/** Due date: the Nth business day after the day of receipt. */
export function dueDate(received, holidays, days = 5) {
  const set = holidays instanceof Set ? holidays : new Set(holidays);
  let t = toUtc(received), n = 0;
  while (n < days) { t += DAY; if (isBusinessDay(iso(t), set)) n++; }
  return iso(t);
}

/** Business days from today (exclusive) to the due date (inclusive). 0 = due today, negative = late. */
export function businessDaysLeft(today, due, holidays) {
  const set = holidays instanceof Set ? holidays : new Set(holidays);
  if (today === due) return 0;
  let t = toUtc(today), n = 0;
  const end = toUtc(due);
  if (end > t) { while (t < end) { t += DAY; if (isBusinessDay(iso(t), set)) n++; } return n; }
  while (t > end) { if (isBusinessDay(iso(t), set)) n--; t -= DAY; }
  return n;
}

/** Today's date in a time zone, as YYYY-MM-DD. */
export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Words for the deadline, never color alone. */
export function deadlineLabel(left) {
  if (left > 1) return `${left} days left`;
  if (left === 1) return '1 day left';
  if (left === 0) return 'Due today';
  return left === -1 ? 'Late by 1 day' : `Late by ${-left} days`;
}
