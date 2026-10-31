// @ts-check
/**
 * LLM provider abstraction. A provider takes a system prompt, a user message
 * and a JSON schema, and returns parsed JSON plus token usage. Only the
 * Anthropic provider is implemented; another provider only needs to implement
 * generateJson() with the same contract.
 *
 * @typedef {{
 *   name: string,
 *   model: string,
 *   generateJson: (req: {system: string, user: string, schema: object, maxTokens?: number, purpose: string}) =>
 *     Promise<{data: any, usage: {inputTokens: number, outputTokens: number}, attempts: number, stopReason: string}>
 * }} LlmProvider
 */

export class AiError extends Error {
  /** @param {string} code @param {string} message @param {{status?: number, retryable?: boolean, attempts?: number}} [o] */
  constructor(code, message, o = {}) {
    super(message);
    this.code = code;
    this.status = o.status;
    this.retryable = Boolean(o.retryable);
    this.attempts = o.attempts ?? 1;
  }
}

/**
 * Wraps a provider to record token use and cost per call in ai_usage.
 * @param {LlmProvider} provider
 * @param {import('../db.mjs').Database} db
 * @param {{priceInputPerMTok: number | null, priceOutputPerMTok: number | null}} prices
 */
export function withUsageTracking(provider, db, prices) {
  return {
    ...provider,
    /** @param {Parameters<LlmProvider['generateJson']>[0] & {tenantId?: string, userId?: string}} req */
    async generateJson(req) {
      try {
        const res = await provider.generateJson(req);
        const cost = prices.priceInputPerMTok != null && prices.priceOutputPerMTok != null
          ? (res.usage.inputTokens * prices.priceInputPerMTok + res.usage.outputTokens * prices.priceOutputPerMTok) / 1e6 : null;
        db.run('INSERT INTO ai_usage (tenant_id, user_id, purpose, provider, model, input_tokens, output_tokens, cost_usd, attempts, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          req.tenantId ?? null, req.userId ?? null, req.purpose, provider.name, provider.model, res.usage.inputTokens, res.usage.outputTokens, cost, res.attempts, 'success');
        return res;
      } catch (err) {
        db.run('INSERT INTO ai_usage (tenant_id, user_id, purpose, provider, model, attempts, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)',
          req.tenantId ?? null, req.userId ?? null, req.purpose, provider.name, provider.model, err instanceof AiError ? err.attempts : 1, err instanceof AiError ? err.code : 'error');
        throw err;
      }
    }
  };
}
