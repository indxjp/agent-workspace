/* global console */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const required = [
  'DATABASE_URL',
  'MASTER_ENCRYPTION_KEY',
  'BOOTSTRAP_ADMIN',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'SESSION_SECRET',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'RUNTIME_DRIVER',
  'RUNNER_URL',
  'MODEL_GATEWAY_URL',
  'GATEWAY_TOKEN_SECRET',
  'AW_SESSION_TRANSCRIPT_ROOT',
];

const variables = Object.fromEntries(
  required.map((name) => [name, process.env[name]?.trim() ? 'present' : 'missing']),
);
/** @type {{ service: string, state: string, health: string }[]} */
const services = [];
const report = { generatedAt: new Date().toISOString(), variables, services };

const compose = spawnSync('docker', ['compose', 'ps', '--format', 'json'], { encoding: 'utf8' });
if (compose.status === 0) {
  for (const line of compose.stdout.split(/\r?\n/u).filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      services.push({
        service: item.Service ?? item.Name ?? 'unknown',
        state: item.State ?? 'unknown',
        health: item.Health ?? 'unknown',
      });
    } catch {
      services.push({ service: 'compose', state: 'unparseable', health: 'unknown' });
    }
  }
}

console.log(JSON.stringify(report, null, 2));
