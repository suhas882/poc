/** Browser-local persistence. Every access is guarded: storage can be blocked or empty. */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function remove(...keys: string[]): void {
  try { for (const k of keys) localStorage.removeItem(k); } catch { /* storage unavailable */ }
}

export function download(text: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const KEYS = {
  plan: 'v2-search-plan',
  scenario: 'v2-active-request-id',
  actor: 'v2-demo-actor',
  events: 'v2-search-events',
  marks: 'v2-review-marks',
  notes: 'v2-review-notes',
  labels: 'v2-label-votes',
  theme: 'v2-ui-theme'
} as const;
