/* global process, console, URL, Buffer, Headers */

/**
 * The support process of the Builder journey's run stack (`builder-chat.spec.mjs`), started by
 * `playwright.config.ts` before the runner, the gateway and the web server it serves.
 *
 * 1. A database of its own (`BUILDER_DATABASE_URL`), migrated and seeded, so the journey's
 *    workspace, model connection and Builder never reach the seeded workspace the other specs
 *    share (`surface-origins.spec.mjs` needs that one to have no model connection).
 * 2. A loopback "Anthropic" upstream on `BUILDER_UPSTREAM_PORT` that lists the models first-run
 *    setup probes and discovers (`GET /v1/models`) and replays a scripted model otherwise. The
 *    Builder is pinned to `claude-sonnet-5-5` (`builder_model_unavailable` refuses any other
 *    model), so the gateway never takes its own `scripted:` branch for it; the gateway reaches
 *    this upstream through the `default` connection's base URL and gets the same replay, turn rule
 *    included, from the gateway's provider registry, which takes `AW_SCRIPTED_MODELS_DIR` in the
 *    `local` posture (`playwright.config.ts` sets both for this process).
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';

import { createProviderRegistry } from '@agent-workspace/gateway/providers/registry';
import pg from 'pg';

const root = path.resolve(import.meta.dirname, '..', '..');

const { DATABASE_URL, BUILDER_DATABASE_URL, BUILDER_UPSTREAM_PORT } = process.env;
if (!DATABASE_URL || !BUILDER_DATABASE_URL || !BUILDER_UPSTREAM_PORT) {
  throw new Error('DATABASE_URL, BUILDER_DATABASE_URL and BUILDER_UPSTREAM_PORT are required.');
}

// The database is dropped and made again, so refuse anything but a loopback `*_builder` database
// beside the suite's own: a mistyped URL must never reach a shared or a real database.
const target = new URL(BUILDER_DATABASE_URL);
const databaseName = decodeURIComponent(target.pathname.slice(1));
const adminName = decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1));
if (!databaseName.endsWith('_builder') || databaseName === adminName) {
  throw new Error(
    `Refusing to drop ${databaseName}: it must end in _builder and differ from ${adminName}.`,
  );
}
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
  throw new Error(
    `Refusing to drop a database on ${target.hostname}: only a loopback host is allowed.`,
  );
}
const admin = new pg.Client({ connectionString: DATABASE_URL });
await admin.connect();
const quoted = admin.escapeIdentifier(databaseName);
await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${quoted}`);
await admin.end();

for (const script of ['migrate.js', 'seed.js']) {
  const result = spawnSync('node', [path.join(root, 'packages/core/dist/db', script)], {
    env: { ...process.env, DATABASE_URL: BUILDER_DATABASE_URL },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`db/${script} failed (${String(result.status)})`);
}

const SCRIPTED_MODEL = 'scripted:expense-refunds-happy';
const BUILDER_MODEL = 'claude-sonnet-5-5';
const [anthropic] = createProviderRegistry();
if (anthropic === undefined) throw new Error('the gateway registers no provider');
// What first-run setup's discovery finds: the model it seeds the wizard's agent with.
const SETUP_MODEL = 'claude-sonnet-4-5';
const upstream = createServer((request, response) => {
  if (
    request.method === 'GET' &&
    new URL(request.url ?? '/', 'http://upstream').pathname === '/v1/models'
  ) {
    const data = [SETUP_MODEL, BUILDER_MODEL].map((id) => ({
      id,
      type: 'model',
      display_name: id,
      created_at: '2026-01-01T00:00:00Z',
    }));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data, has_more: false }));
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    void (async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const answer = await anthropic.createMessage(
        { ...body, model: SCRIPTED_MODEL },
        {
          providerId: anthropic.id,
          credential: 'scripted',
          requestId: 'builder-upstream',
          settings: {},
          headers: new Headers(),
        },
      );
      // The reply names the model it answers as. The session records that name and the next turn
      // asks for it, so it has to be the Builder's own model, not the script's.
      const reply = (await answer.text()).replaceAll(SCRIPTED_MODEL, BUILDER_MODEL);
      const headers = Object.fromEntries(answer.headers);
      delete headers['content-length'];
      response.writeHead(answer.status, headers);
      response.end(reply);
    })().catch((error) => {
      console.error(error);
      response.writeHead(500).end();
    });
  });
});
upstream.listen(Number(BUILDER_UPSTREAM_PORT), '127.0.0.1', () => {
  console.log(`builder upstream on ${BUILDER_UPSTREAM_PORT}`);
});
