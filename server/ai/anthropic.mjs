// @ts-check
/**
 * Anthropic Messages API provider (no SDK dependency).
 * Uses structured outputs (output_config.format = json_schema) so responses
 * follow the schema, then the caller still validates them. Retries 429, 5xx
 * and 529 (overloaded) with exponential backoff, honouring retry-after.
 */
import { AiError } from './provider.mjs';

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {import('../config.mjs').AppConfig['anthropic']} cfg
 * @param {{fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>}} [deps]
 * @returns {import('./provider.mjs').LlmProvider}
 */
export function createAnthropicProvider(cfg, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const wait = deps.sleep ?? sleep;
  return {
    name: 'anthropic',
    model: cfg.model,
    async generateJson({ system, user, schema, maxTokens }) {
      const body = JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens ?? cfg.maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { format: { type: 'json_schema', schema } }
      });
      let attempt = 0;
      for (;;) {
        attempt++;
        let res;
        try {
          res = await doFetch(`${cfg.baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
            body,
            signal: AbortSignal.timeout(cfg.timeoutMs)
          });
        } catch (err) {
          if (attempt <= cfg.maxRetries) { await wait(backoff(attempt)); continue; }
          throw new AiError('network_error', 'Could not reach the Claude API.', { retryable: true, attempts: attempt });
        }
        if (res.ok) {
          const json = await res.json();
          const stop = json.stop_reason;
          if (stop === 'refusal') throw new AiError('refusal', 'Claude declined to answer this request.', { attempts: attempt });
          if (stop === 'max_tokens') throw new AiError('truncated', 'Claude’s answer was cut off. Increase ANTHROPIC_MAX_TOKENS.', { attempts: attempt });
          const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          let data;
          try { data = JSON.parse(text); } catch { throw new AiError('invalid_json', 'Claude returned text that is not valid JSON.', { attempts: attempt }); }
          return { data, usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 }, attempts: attempt, stopReason: stop };
        }
        if (RETRYABLE.has(res.status) && attempt <= cfg.maxRetries) {
          const ra = Number(res.headers.get('retry-after'));
          await wait(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : backoff(attempt));
          continue;
        }
        let message = `The Claude API returned HTTP ${res.status}.`;
        try { const e = await res.json(); if (e?.error?.message) message += ` ${String(e.error.message).slice(0, 300)}`; } catch { /* ignore */ }
        const code = res.status === 401 ? 'auth_failed' : res.status === 429 ? 'rate_limited' : res.status === 529 ? 'overloaded' : res.status === 400 ? 'bad_request' : 'api_error';
        throw new AiError(code, message, { status: res.status, retryable: RETRYABLE.has(res.status), attempts: attempt });
      }
    }
  };
}

const backoff = (attempt) => Math.min(16000, 500 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
