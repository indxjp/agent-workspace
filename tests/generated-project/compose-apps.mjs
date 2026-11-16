#!/usr/bin/env node
/* global fetch, setTimeout, AbortSignal */
/**
 * Proof that `compose.apps.yaml` boots (issue #1512): a stand-in app image is pushed to a throwaway
 * `registry:2` for a digest reference, the overlay `renderComposeApps` writes is merged over a base
 * file with the platform's `postgres` (the same pinned major) and a healthy `web`, and the app
 * then answers `/api/health`, connects as its own role `app_fixture`, is refused a platform
 * table, and can create no schema but its own (it holds no `CREATE` on the database).
 *
 *   pnpm build && node tests/generated-project/compose-apps.mjs
 *
 * It needs Docker, and reads the built `@indx-workspace/cli` (`packages/cli/dist`), so CI's
 * generated-project-e2e job runs it after restoring the workspace build. Everything it starts (the
 * registry, the image, the Compose project and its volumes, the temporary directory) is removed
 * whether it passes or fails.
 *
 * The base file stands in for the platform's `compose.yaml`: booting the whole platform needs its
 * four release images, which the generated-project lane builds and the apps lane (#1531) boots.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import {
  COMPOSE_APPS_FILE,
  COMPOSE_FILE_WITH_APPS,
  renderComposeApps,
} from '@indx-workspace/cli/deploy';

const IMAGE_CONTEXT = fileURLToPath(
  new URL('../../packages/cli/src/deploy/fixtures/app-image/', import.meta.url),
);
const POSTGRES_IMAGE = 'docker.io/library/postgres:18-alpine';
const DATABASE = 'agent_workspace';
const SUPERUSER = 'agent_workspace';
const STEP_TIMEOUT_MS = 300_000;

/**
 * Run `docker <args>`; argument arrays only, never a shell. With `check` (the default) a non-zero
 * exit throws with its stderr.
 *
 * @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, check?: boolean }} [options]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
  });
  const outcome = { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  if ((options.check ?? true) && outcome.status !== 0) {
    throw new Error(`docker ${args.join(' ')} exited ${String(outcome.status)}: ${outcome.stderr}`);
  }
  return outcome;
}

/**
 * The base file: the platform's postgres, and a `web` that is healthy as soon as it listens.
 * Written as JSON, which Compose reads as the YAML it is a subset of.
 *
 * @param {string} appImage
 */
function baseCompose(appImage) {
  return `${JSON.stringify(
    {
      name: '${COMPOSE_PROJECT_NAME:?set COMPOSE_PROJECT_NAME}',
      services: {
        postgres: {
          image: '${POSTGRES_IMAGE:?}',
          environment: {
            POSTGRES_DB: '${POSTGRES_DB:?}',
            POSTGRES_USER: '${POSTGRES_USER:?}',
            POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:?}',
          },
          healthcheck: {
            test: ['CMD-SHELL', 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'],
            interval: '2s',
            timeout: '5s',
            retries: 60,
          },
          networks: ['control'],
        },
        web: {
          image: appImage,
          healthcheck: {
            test: [
              'CMD',
              'node',
              '-e',
              "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))",
            ],
            interval: '2s',
            timeout: '5s',
            retries: 60,
          },
          networks: ['control'],
        },
      },
      networks: { control: { internal: true } },
    },
    undefined,
    2,
  )}\n`;
}

/**
 * Poll `url` until it answers 200 or `deadline` passes; returns the last status (0: never answered).
 *
 * @param {string} url
 * @param {number} deadline epoch milliseconds
 */
async function waitForHealth(url, deadline) {
  let last = 0;
  while (Date.now() < deadline) {
    try {
      last = (await fetch(url, { signal: AbortSignal.timeout(5_000) })).status;
      if (last === 200) return last;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return last;
}

async function main() {
  const suffix = randomBytes(4).toString('hex');
  const project = `aw-compose-apps-${suffix}`;
  let directory = '';
  let registry = '';
  let image = '';
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE: COMPOSE_FILE_WITH_APPS,
  };
  /** @param {readonly string[]} args */
  const compose = (args, check = true) =>
    docker(['compose', ...args], { cwd: directory, env, check });
  /** @param {string} sql */
  const asApp = (sql) =>
    compose(
      [
        'exec',
        '-T',
        'postgres',
        'sh',
        '-c',
        // The app's own DATABASE_URL, read from the app container, so the check is of what it got.
        // -q drops command tags (CREATE TABLE, DROP TABLE): psql 15+ prints a result for every
        // statement of a multi-statement -c, so stdout holds only query rows; errors still go to
        // stderr and ON_ERROR_STOP makes any failed statement a non-zero exit.
        `psql "$1" -X -q -tA -v ON_ERROR_STOP=1 -c "$2"`,
        'sh',
        compose([
          'exec',
          '-T',
          'app-fixture',
          'node',
          '-e',
          // Host `postgres` is the container's network address, not loopback, so the password counts.
          'process.stdout.write(process.env.DATABASE_URL)',
        ]).stdout,
        sql,
      ],
      false,
    );

  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'aw-compose-apps-'));
    registry = docker([
      'run',
      '--detach',
      '--rm',
      '-p',
      '127.0.0.1::5000',
      'registry:2',
    ]).stdout.trim();
    const port = docker(['port', registry, '5000/tcp']).stdout.trim().split(':').at(-1) ?? '';
    const tag = `127.0.0.1:${port}/aw-compose-apps-fixture:${suffix}`;
    docker(['build', '--tag', tag, IMAGE_CONTEXT]);
    docker(['push', tag]);
    image = docker(['inspect', '--format', '{{index .RepoDigests 0}}', tag]).stdout.trim();

    await writeFile(path.join(directory, 'compose.yaml'), baseCompose(image));
    await writeFile(
      path.join(directory, COMPOSE_APPS_FILE),
      renderComposeApps(
        { fixture: { image, url: 'https://fixture.example.test' } },
        'https://agents.example.test',
      ),
    );
    const secret = () => randomBytes(32).toString('base64url');
    await writeFile(
      path.join(directory, '.env'),
      [
        `COMPOSE_PROJECT_NAME=${project}`,
        `POSTGRES_IMAGE=${POSTGRES_IMAGE}`,
        `POSTGRES_DB=${DATABASE}`,
        `POSTGRES_USER=${SUPERUSER}`,
        `POSTGRES_PASSWORD=${secret()}`,
        `AW_APP_FIXTURE_DB_PASSWORD=${secret()}`,
        `AW_APP_FIXTURE_IDENTITY_SECRET=${secret()}`,
        `COMPOSE_FILE=${COMPOSE_FILE_WITH_APPS}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    // `up` starts app-fixture once its role service completed and web is healthy.
    compose(['up', '--detach', 'app-fixture']);
    assert.equal(
      await waitForHealth('http://127.0.0.1:3100/api/health', Date.now() + 180_000),
      200,
      'the app answers /api/health',
    );
    const services = compose(['ps', '--all', '--format', '{{.Service}} {{.ExitCode}}']).stdout;
    assert.ok(services.includes('app-fixture-role 0'), `the role job completed:\n${services}`);

    assert.equal(asApp('select current_user').stdout.trim(), 'app_fixture');
    assert.equal(
      asApp(
        "select nspowner::regrole::text from pg_namespace where nspname = 'app_fixture'",
      ).stdout.trim(),
      'app_fixture',
    );

    // A platform table: the superuser's, in public, as the platform's migrations create them.
    compose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      SUPERUSER,
      '-d',
      DATABASE,
      '-c',
      'CREATE TABLE IF NOT EXISTS public.agents (id int)',
    ]);
    const refused = asApp('SELECT 1 FROM public.agents');
    assert.notEqual(refused.status, 0, 'the app reads a platform table');
    assert.ok(refused.stderr.includes('permission denied'), refused.stderr);

    // Another app's schema, before that app's role job creates it: the role cannot create it,
    // with or without IF NOT EXISTS, so it can never own objects in another app's schema.
    for (const statement of ['CREATE SCHEMA app_other', 'CREATE SCHEMA IF NOT EXISTS app_other']) {
      const created = asApp(statement);
      assert.notEqual(created.status, 0, `the app ran ${statement}`);
      assert.ok(created.stderr.includes('permission denied'), created.stderr);
    }
    // Its own schema is still usable: it owns app_fixture and creates tables in it.
    const ownSchema = asApp(
      'CREATE TABLE app_fixture.probe (id int); DROP TABLE app_fixture.probe; SELECT 1',
    );
    assert.equal(ownSchema.status, 0, `the app could not use its own schema:\n${ownSchema.stderr}`);
    assert.equal(ownSchema.stdout.trim(), '1');
    process.stdout.write(
      'compose.apps.yaml: app-fixture answered /api/health as app_fixture, refused a platform table and another schema\n',
    );
  } finally {
    if (directory !== '') {
      compose(['down', '--volumes', '--remove-orphans'], false);
      await rm(directory, { recursive: true, force: true });
    }
    if (image !== '') docker(['image', 'rm', '--force', image], { check: false });
    if (registry !== '') docker(['rm', '--force', registry], { check: false });
  }
}

await main();
