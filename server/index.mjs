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
  console.log(config.demoOnly ? 'Mode: synthetic demo only (DEMO_ONLY=true).' : [
    `Claude: ${s.ai ? `on (${s.ai.model})` : 'off (set ANTHROPIC_API_KEY)'}`,
    `Semantic search: ${s.embedder ? `on (${s.embedder.provider}/${s.embedder.model})` : s.embedderError ? `error: ${s.embedderError}` : 'off (set EMBEDDINGS_PROVIDER)'}`,
    `Gmail: ${s.gmail.configured ? 'configured' : 'not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'}`
  ].join(' · '));
  if (!config.demoOnly && !s.db.get('SELECT 1 FROM users LIMIT 1')) console.log(`No users yet. Open http://localhost:${config.port}/login.html on this computer to create the first administrator.`);
});

const stop = () => server.close(async () => { await app.close(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
