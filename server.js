// Entry point (kept for existing start commands: `node server.js`).
// The server now lives in ./server; it needs Node.js 22.13 or newer for the built-in SQLite module.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js ${process.versions.node} is too old. Install Node.js 22.13 or newer (24 LTS recommended).`);
  process.exit(1);
}
import('./server/index.mjs').catch(err => { console.error(err); process.exit(1); });
