// @ts-check
/**
 * Embedding providers for semantic search. Anthropic does not offer an
 * embeddings API; its docs point to Voyage AI. Any OpenAI-compatible
 * /embeddings endpoint (including a self-hosted model) also works.
 * With EMBEDDINGS_PROVIDER=none, semantic search is off and the UI says so.
 */

/**
 * @param {import('../config.mjs').AppConfig['embeddings']} cfg
 * @param {{fetch?: typeof fetch}} [deps]
 * @returns {{model: string, provider: string, embed: (texts: string[], kind: 'document' | 'query') => Promise<number[][]>} | null}
 */
export function createEmbedder(cfg, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  if (cfg.provider === 'none' || !cfg.provider) return null;
  if (!cfg.model) throw new Error('EMBEDDINGS_MODEL must be set when EMBEDDINGS_PROVIDER is not "none".');
  if (cfg.provider === 'voyage') {
    if (!cfg.apiKey) throw new Error('EMBEDDINGS_API_KEY (or VOYAGE_API_KEY) is required for Voyage embeddings.');
    const base = cfg.baseUrl || 'https://api.voyageai.com/v1';
    return {
      model: cfg.model, provider: 'voyage',
      async embed(texts, kind) {
        const out = [];
        for (let i = 0; i < texts.length; i += cfg.batchSize) {
          const res = await doFetch(`${base}/embeddings`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({ input: texts.slice(i, i + cfg.batchSize), model: cfg.model, input_type: kind }), signal: AbortSignal.timeout(60000)
          });
          if (!res.ok) throw new Error(`Embedding request failed with HTTP ${res.status}.`);
          const json = await res.json();
          out.push(...json.data.sort((a, b) => a.index - b.index).map(d => d.embedding));
        }
        return out;
      }
    };
  }
  if (cfg.provider === 'openai-compatible') {
    if (!cfg.baseUrl) throw new Error('EMBEDDINGS_BASE_URL is required for an OpenAI-compatible embeddings endpoint.');
    return {
      model: cfg.model, provider: 'openai-compatible',
      async embed(texts) {
        const out = [];
        for (let i = 0; i < texts.length; i += cfg.batchSize) {
          const res = await doFetch(`${cfg.baseUrl}/embeddings`, {
            method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
            body: JSON.stringify({ input: texts.slice(i, i + cfg.batchSize), model: cfg.model }), signal: AbortSignal.timeout(60000)
          });
          if (!res.ok) throw new Error(`Embedding request failed with HTTP ${res.status}.`);
          const json = await res.json();
          out.push(...json.data.sort((a, b) => a.index - b.index).map(d => d.embedding));
        }
        return out;
      }
    };
  }
  throw new Error(`Unknown EMBEDDINGS_PROVIDER "${cfg.provider}". Use none, voyage or openai-compatible.`);
}
