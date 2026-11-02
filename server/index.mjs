// @ts-check
import http from 'node:http';
import os from 'node:os';
import { getConfig, loadDotEnv } from './config.mjs';
import { createApp } from './app.mjs';

loadDotEnv();
const config = getConfig();
const app = createApp(config);
const server = http.createServer(app.handler);
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;

server.listen(config.port, config.host, () => {
  const s = app.services;
  console.log(`Public Records Search listening on port ${config.port}.`);
  console.log(`This computer: http://localhost:${config.port}/`);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) console.log(`Same-network preview: http://${a.address}:${config.port}/`);
  }
  console.log([`Real sources: ${config.realSources ? 'on' : 'off (Tier 0 demo data only)'}`,
    `Claude: ${s.ai ? `on (${s.ai.model})` : 'off (set ANTHROPIC_API_KEY)'}`,
    `Semantic search: ${s.embedder ? `on (${s.embedder.provider}/${s.embedder.model})` : s.embedderError ? `error: ${s.embedderError}` : 'off (set EMBEDDINGS_PROVIDER)'}`,
    `Gmail: ${s.gmail.configured ? 'configured' : 'not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'}`,
    `Microsoft: ${s.microsoft.configured ? 'configured' : 'not configured (set MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET)'}`
  ].join(' · '));
  if (config.realSources && !s.db.get('SELECT 1 FROM users LIMIT 1')) console.log(`No users yet. Open http://localhost:${config.port}/login.html on this computer to create the first administrator.`);
  // Mistakes that are easy to make when moving to a host; say them at startup instead of failing later.
  if (config.production) {
    if (!s.vault) console.log('[deploy] WARNING: CREDENTIAL_ENCRYPTION_KEY is not set. No Google, Microsoft or database account can be connected. When moving data, use the old server\'s key.');
    if (!config.publicUrl.startsWith('https://')) console.log(`[deploy] WARNING: PUBLIC_URL is ${config.publicUrl}. Production needs the https address people open (sign-in cookies and OAuth redirects depend on it).`);
    if (config.realSources && !s.db.get('SELECT 1 FROM users LIMIT 1') && !config.setupToken) console.log('[deploy] WARNING: no users and no SETUP_TOKEN: nobody can create the first Supervisor from a browser.');
  }
});

// Containers stop with SIGTERM: finish open requests, close the database cleanly, and never hang the restart.
const stop = () => {
  setTimeout(() => process.exit(0), 10_000).unref();
  server.closeIdleConnections?.();
  server.close(async () => { await app.close(); process.exit(0); });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
