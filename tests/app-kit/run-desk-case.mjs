/* global console, fetch */
import { reserveDevRuntime } from './run-process.mjs';
import { readBootstrapAdmin } from './run-projects.mjs';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { APP_NAME, closeTicketScript, createDeskProject } from './run-projects.mjs';
import { removeWorkDirectory, startDev, readyWithApp } from './run-process.mjs';
import {
  signIn,
  storeAppIdentity,
  startAndWaitForAgentRun,
  signInAtDevIssuer,
} from './run-identity.mjs';

/** The embedded PostgreSQL's fixed local superuser (`packages/embedded`'s constants). */
const DATABASE_CREDENTIALS = 'agent_workspace:agent_workspace_local';

async function runTicketTriage({ page, appOrigin, token, scriptFile }) {
  console.log('== creating a ticket as the signed-in person');
  const created = await fetch(`${appOrigin}/api/tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'The printer is on fire', status: 'new' }),
  });
  const ticket = await created.json();
  if (created.status !== 201)
    throw new Error(
      `POST /api/tickets answered ${String(created.status)}: ${JSON.stringify(ticket)}`,
    );
  writeFileSync(scriptFile, JSON.stringify(closeTicketScript(ticket.id)));

  console.log('== asking the triage agent, as that person');
  const outcome = await startAndWaitForAgentRun(page, 'triage');
  if (outcome.status !== 'completed')
    throw new Error(`the run ended ${outcome.status}: ${JSON.stringify(outcome.current)}`);

  return { ticket, outcome };
}

async function verifyTicketPersistence({ database, ticket, outcome }) {
  const row = await database.query(`select status from "app_${APP_NAME}"."tickets" where id = $1`, [
    ticket.id,
  ]);
  if (row.rows[0]?.status !== 'closed')
    throw new Error(`the ticket is ${JSON.stringify(row.rows[0])}, not closed`);
  const audit = await database.query(
    `select via, run_id from "app_${APP_NAME}"."app_audit_events" where via = 'agent'`,
  );
  if (audit.rows.length !== 1 || audit.rows[0].run_id !== outcome.id) {
    throw new Error(
      `expected one agent audit row for run ${outcome.id}, found ${JSON.stringify(audit.rows)}`,
    );
  }
  const connector = await database.query(
    `select id, updated_at from mcp_servers where name = $1 and identity_secret_name is not null`,
    [APP_NAME],
  );
  if (connector.rows.length !== 1)
    throw new Error(`expected one ${APP_NAME} connector, found ${String(connector.rows.length)}`);

  return connector;
}

async function verifyDeskRestart({ generated, runtime, pg, connector }) {
  const { aw, project } = generated;
  const { devEnv, devArgs, databaseUrl } = runtime;
  /** @type {import('pg').Client | undefined} */
  let database;
  console.log('== aw dev again: nothing changes');
  const second = startDev(aw, project, devEnv, devArgs);
  try {
    await second.waitFor(readyWithApp);
    if (second.output.stdout.includes('applied: ')) {
      throw new Error(`the second aw dev applied something:\n${second.output.stdout}`);
    }
    database = new pg.Client({ connectionString: databaseUrl });
    database.on('error', () => undefined);
    await database.connect();
    const again = await database.query(
      `select id, updated_at from mcp_servers where name = $1 and identity_secret_name is not null`,
      [APP_NAME],
    );
    const [before] = connector.rows;
    const [after] = again.rows;
    if (after?.id !== before.id || String(after?.updated_at) !== String(before.updated_at)) {
      throw new Error(`the ${APP_NAME} connector changed on the second aw dev`);
    }
  } finally {
    await database?.end().catch(() => undefined);
    await second.stop();
  }
}

async function deskRuntime({ env, scripts }) {
  const { ports, origin, devArgs, devEnv } = await reserveDevRuntime({
    env,
    scripts,
    bases: { web: 3300, gateway: 14300, runner: 18300, database: 26300 },
  });
  const databaseUrl = `postgresql://${DATABASE_CREDENTIALS}@127.0.0.1:${String(ports.database)}/postgres`;

  return { devEnv, devArgs, origin, databaseUrl };
}

function deskSignInSettings(project, stdout) {
  const appOrigin = /^ {2}app {7}(http:\/\/127\.0\.0\.1:\d+)$/mu.exec(stdout)?.[1] ?? '';
  console.log(`== the app is on ${appOrigin}`);
  const admin = readBootstrapAdmin(project);
  if (admin.email === undefined) throw new Error('agent-workspace.yaml names no bootstrapAdmin');
  return { appOrigin, admin };
}

export async function runDeskCase({ work, create, tarballs, env, scripts, scriptFile, keep }) {
  const generated = createDeskProject({ work, create, tarballs, env });
  const { project, manifest, aw } = generated;

  const runtime = await deskRuntime({ env, scripts });
  const { devEnv, devArgs, origin, databaseUrl } = runtime;

  console.log(`== aw dev on ${origin}`);
  const first = startDev(aw, project, devEnv, devArgs);
  /** @type {import('pg').Client | undefined} */
  let database;
  /** @type {import('@playwright/test').Browser | undefined} */
  let browser;
  try {
    await first.waitFor(readyWithApp);
    const { appOrigin, admin } = deskSignInSettings(project, first.output.stdout);
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
    const { page, token } = await signIn(browser, origin, admin);

    await storeAppIdentity(page, project, APP_NAME, first.output.stderr);

    const { ticket, outcome } = await runTicketTriage({ page, appOrigin, token, scriptFile });
    const pg = createRequire(manifest)('pg');
    database = new pg.Client({ connectionString: databaseUrl });
    // A runtime that stops ends the connection: a failure then, never an unhandled event.
    database.on('error', () => undefined);
    await database.connect();
    const connector = await verifyTicketPersistence({ database, ticket, outcome });
    await signInAtDevIssuer(page, {
      origin,
      appOrigin,
      ...admin,
      personToken: token,
    });
    await database.end();
    database = undefined;
    await browser.close();
    browser = undefined;
    await first.stop();

    await verifyDeskRestart({ generated, runtime, pg, connector });
    console.log('== app-kit E2E passed');
    if (!keep) removeWorkDirectory(work);
  } catch (error) {
    console.error(`app-kit E2E failed; the work directory is kept at ${work}`);
    console.error(`aw dev stdout:\n${first.output.stdout}\naw dev stderr:\n${first.output.stderr}`);
    throw error;
  } finally {
    await database?.end().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await first.stop();
  }
}
