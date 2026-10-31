#!/usr/bin/env node
// Create a user from the command line (useful on a server with no browser on localhost).
// Usage: node scripts/create-admin.mjs --email you@city.gov --name "Your Name" [--role admin] [--org "City of Example"]
// The password is read from the ADMIN_PASSWORD environment variable, or asked for interactively.
import crypto from 'node:crypto';
import readline from 'node:readline';
import { getConfig, loadDotEnv } from '../server/config.mjs';
import { Database } from '../server/db.mjs';
import { hashPassword, passwordProblem } from '../server/security.mjs';
import { ROLES } from '../server/auth.mjs';
import { seedSyntheticSource } from '../server/connectors/synthetic.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.email || !args.name) { console.error('Usage: node scripts/create-admin.mjs --email you@city.gov --name "Your Name" [--role admin] [--org "City name"]'); process.exit(1); }
const role = args.role || 'admin';
if (!ROLES.includes(role)) { console.error(`Role must be one of: ${ROLES.join(', ')}`); process.exit(1); }

async function askHidden(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
  return new Promise(r => rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); r(a); }));
}

loadDotEnv();
const config = getConfig();
const db = new Database(config.dbPath);
db.migrate();
const password = process.env.ADMIN_PASSWORD || await askHidden('Password (at least 12 characters): ');
const problem = passwordProblem(password);
if (problem) { console.error(problem); process.exit(1); }
if (db.get('SELECT 1 FROM users WHERE email = ?', args.email.toLowerCase())) { console.error('A user with that email already exists.'); process.exit(1); }
let tenant = db.get('SELECT id FROM tenants ORDER BY created_at LIMIT 1');
if (!tenant) {
  tenant = { id: crypto.randomUUID() };
  db.run('INSERT INTO tenants (id, name) VALUES (?, ?)', tenant.id, args.org || 'My organization');
  seedSyntheticSource(db, tenant.id);
}
const id = crypto.randomUUID();
db.run('INSERT INTO users (id, tenant_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)', id, tenant.id, args.email.toLowerCase(), args.name, role, hashPassword(password));
db.run("INSERT INTO audit_events (tenant_id, user_id, action, target_type, target_id, outcome, details, created_at) VALUES (?, NULL, 'user.created', 'user', ?, 'success', ?, ?)", tenant.id, id, JSON.stringify({ role, via: 'cli' }), new Date().toISOString());
console.log(`Created ${role} ${args.email} in ${config.dbPath}.`);
db.close();
