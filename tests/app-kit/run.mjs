#!/usr/bin/env node
/* global console, fetch, setTimeout, clearTimeout, URL, URLSearchParams */
/**
 * The app-kit E2E (issue #1506): an agent updates a generated app's record as the signed-in person
 * who asked, against this checkout's own packages, with no Docker and no model key.
 *
 *   pnpm build && node tests/app-kit/run.mjs
 *
 * 1. Pack the nine published `@indx-workspace` packages (`scripts/release/pack-packages.mjs`, which
 *    refuses an unpublishable tarball) and install them into an empty consumer from `file:`, as the
 *    generated-project E2E does in its step 1.
 * 2. Generate the project as a developer does: `create --yes --no-install --no-start`, then
 *    `aw generate app desk`, `aw generate resource ticket title:text 'status:enum(new,closed)'`,
 *    with `agents: { read: true, write: ['status'] }` edited into `resources/ticket.ts`, and
 *    `aw generate agent triage --tools ticket` on the model `scripted:close-ticket`. The project's
 *    `@indx-workspace/*` dependencies point at the tarballs (the only edit that is not the
 *    developer's); everything else comes from npm. `npx tsc --noEmit` type-checks the generated
 *    app, its pages included.
 * 3. `aw dev` until its ready screen names the app and the first sync saved the agent. The local
 *    runtime runs on its embedded PostgreSQL and the `local` driver; `AW_SCRIPTED_MODELS_DIR` serves
 *    the scripted model, so no provider key is needed.
 * 4. Sign in as the bootstrap Owner in Chromium (the console's own form), approve a device code for
 *    a person token (`awu_live_…`, the token `aw login` holds), create a ticket through the app's
 *    `POST /api/tickets` with it, and start the triage agent from the signed-in console, so the run's
 *    caller is the person (ADR-0142 D2). `aw chat` is not used: in a project it runs as the
 *    runtime's API key, which names no caller, and a connector that asks for an identity refuses
 *    such a run before it is dialled.
 * 5. Assert, reading PostgreSQL directly: the ticket's `status` is `closed`, and `app_desk` holds
 *    one `app_audit_events` row with `via = 'agent'` and the run's id.
 * 6. Issue #2075 (ADR-0161's 2026-11-01 amendment): sign the bootstrap Owner in at `aw dev`'s
 *    development OIDC issuer with the local console password (its `/authorize` form, S256 PKCE),
 *    trade the code and the ID token through a route planted in the app ({@link SIGN_IN_PROOF_ROUTE},
 *    the reduced callback U3.6-b generates, on the app's own `AW_OIDC_*` and `AW_APP_CLIENT_*`
 *    names) for an `awo_live_` token with `aw.auth.exchange`, start a run of a bound agent with it,
 *    and assert the run's initiating person is the Owner. The person token is still `401` on the
 *    same run route (ADR-0083 is unchanged).
 * 7. Stop `aw dev` and start it again: the second start applies nothing (no `applied:` line) and
 *    the app's connector keeps its id and `updated_at`.
 *
 * The portal case (issue #1510) runs first: `create portal --template portal --yes`, the project
 * on the tarballs, `npx tsc --noEmit` over its pages, then the `run:` steps of its generated
 * `.github/workflows/app-ci.yml` (its `npm ci` stands in for the install just made). They pass;
 * then a planted `import '@agent-workspace/core'` makes the import check exit non-zero, and a
 * planted `@agent-workspace/core` dependency makes the package check exit non-zero.
 * Then (U3.6-b) the portal runs under `aw dev` and Chromium signs the Owner in through its own
 * `/sign-in` and the development issuer's form: a wrong password stays signed out with the
 * issuer's refusal shown, the right one lands on `/` with the `awo_live_` token in the app's
 * cookie, and a run of the bound `assistant` agent started with that token is the Owner's and is
 * listed on the Dashboard and `/runs` (the run list read as the person, ADR-0161's #1530 amendment).
 * `--case portal` runs only that case, `--case desk` only the steps above.
 *
 * The preset cases (issue #1511) follow the portal: `create <dir> --template chat|wiki|crm|desk
 * --yes` in `team-chat`, `wiki`, `crm` and `service-desk` (the reference apps' directories, so the
 * app is named after the directory), each on the tarballs, `npx tsc --noEmit` and `next build`
 * before any `aw generate`. The wiki then runs under `aw dev` until ready, and the signed-in
 * person's `GET /api/pages` answers 200 with no pages, so its migration applied. The crm runs every
 * `npx aw` command its README lists (the reference app's script after `npm create`) without a path
 * conflict, and type-checks again. `--case <dir>` runs one of them.
 *
 * It needs `npm`, network access to the npm registry (Next.js, React, Drizzle, `pg`) and
 * Playwright's Chromium (`pnpm exec playwright install chromium`). Environment: `APP_KIT_WORK_DIR`
 * (default: a new temporary directory; kept when the run fails, removed when it passes unless set)
 * and `APP_KIT_TIMEOUT_MS` (40 minutes: the cap on the whole run), a positive integer or the run
 * stops naming it. Every port is the first free one from a base well away from the defaults, so a
 * runtime already on 3000/4000/8080/25432 is left alone.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { PUBLISHED_PACKAGES } from '../../scripts/release/pack-packages.mjs';
import { run } from '../generated-project/project.mjs';
import { positiveIntegerVariable } from '../generated-project/run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The names the run generates. */
export const APP_NAME = 'desk';
export const PROJECT_NAME = 'desk-project';
export const SCRIPTED_MODEL = 'close-ticket';

/** The embedded PostgreSQL's fixed local superuser (`packages/embedded`'s constants). */
const DATABASE_CREDENTIALS = 'agent_workspace:agent_workspace_local';

/** What the type check installs: the repository's own TypeScript and type packages. */
export const TYPE_CHECK_PACKAGES = [
  'typescript@npm:@typescript/typescript6@6.0.2',
  '@types/react@19.3.0',
  '@types/node@26.6.6',
  '@types/pg@8.23.1',
];

/** The portal case's project, written by `create --template portal`. */
export const PORTAL_PROJECT = 'portal';

/** The workflow `create --template portal` writes, relative to the project. */
export const APP_CI_WORKFLOW = '.github/workflows/app-ci.yml';

/**
 * The `run:` steps of the generated app CI, in order: each is one line (the SDK's template test
 * holds them so), so a line match reads them exactly as a YAML parser does.
 *
 * @param {string} workflow
 */
export function ciRunSteps(workflow) {
  return [...workflow.matchAll(/^ {6}- run: (.+)$/gmu)].map((match) => match[1] ?? '');
}

/**
 * Removes the work directory. A run this E2E starts writes its skills `0o444` under `0o555`
 * directories, as `packages/engine/src/skills.ts` intends, and an entry of a directory without its
 * write bit cannot be removed. So every directory in the tree (never through a symlink) gets its
 * owner's `rwx` back before the tree is removed; the files need nothing, as removing one asks only
 * for its directory's write bit.
 *
 * @param {string} directory
 */
export function removeWorkDirectory(directory) {
  /** @param {string} at */
  const writable = (at) => {
    const stats = lstatSync(at, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isDirectory()) return;
    if ((stats.mode & 0o700) !== 0o700) chmodSync(at, (stats.mode & 0o7777) | 0o700);
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) writable(path.join(at, entry.name));
    }
  };
  writable(directory);
  rmSync(directory, { recursive: true, force: true });
}

/** The cases `--case` names: the portal, the presets (by their directories), then `desk`. */
const CASES = ['portal', 'team-chat', 'wiki', 'crm', 'service-desk', 'desk'];

/**
 * The cases to run: every one, or the one `--case <name>` names.
 *
 * @param {readonly string[]} argv
 */
export function casesOf(argv) {
  const at = argv.indexOf('--case');
  if (at === -1) return CASES;
  const named = argv[at + 1];
  if (named === undefined || !CASES.includes(named)) {
    throw new Error(`--case takes one of ${CASES.join(', ')}`);
  }
  return [named];
}

/** How long `aw dev` may take to say it is ready, and to stop. */
const READY_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 60_000;

/**
 * `source` with the resource's `agents` setting replaced by `{ read: true, write: ['status'] }`,
 * the one edit the developer makes to `resources/ticket.ts`. Throws when the generated line moved.
 *
 * @param {string} source
 */
export function withAgentWrite(source) {
  const line = '  agents: { read: true, write: false },';
  if (!source.includes(line)) throw new Error('resources/ticket.ts has no generated agents line');
  return source.replace(line, "  agents: { read: true, write: ['status'] },");
}

/**
 * `source` with its agent on the model `model` of the `default` connection: any `model:` line is
 * dropped and `model: { connection: 'default', id: '<model>' }` follows the agent's `name:` line.
 * Every agent of the project runs on a scripted model, so `aw dev` needs no provider key.
 *
 * @param {string} source @param {string} model
 */
export function withModel(source, model) {
  const without = source.replace(/^ {2}model: .*,\n/mu, '');
  const match = /^ {2}name: '[^']+',$/mu.exec(without);
  if (match === null) throw new Error('the agent file has no name line');
  const at = match.index + match[0].length;
  return `${without.slice(0, at)}\n  model: { connection: 'default', id: '${model}' },${without.slice(at)}`;
}

/**
 * The scripted model's turns: close the ticket through the app's tool, then say so.
 *
 * @param {string | undefined} ticketId undefined: a text-only placeholder, before the ticket exists
 */
export function closeTicketScript(ticketId) {
  if (ticketId === undefined) return { turns: [{ text: 'There is no ticket yet.' }] };
  return {
    turns: [
      {
        toolUses: [
          { name: `mcp__${APP_NAME}__ticket_update`, input: { id: ticketId, status: 'closed' } },
        ],
      },
      { text: 'Closed the ticket.' },
    ],
  };
}

/** Where the E2E plants its sign-in proof route in the generated app, relative to the project. */
export const SIGN_IN_PROOF_ROUTE = 'app/api/e2e-sign-in/route.ts';

/**
 * The planted route (issue #2075): `GET` names the app's issuer and client id (never a secret);
 * `POST { code, verifier, redirectUri }` redeems the code at the issuer's token endpoint with the app's
 * `client_secret_basic` pair and trades the ID token with `aw.auth.exchange`, answering only the
 * `awo_live_` token. It stands in for U3.6-b's `/api/sign-in/callback`, which keeps that token in a
 * cookie instead; it lives only in the E2E's temporary project.
 */
export function signInProofRoute() {
  return `import { createClient } from '@indx-workspace/sdk';

export function GET(): Response {
  return Response.json({
    issuer: process.env['AW_OIDC_ISSUER_URL'] ?? null,
    clientId: process.env['AW_OIDC_CLIENT_ID'] ?? null,
    appBackend: process.env['AW_APP_CLIENT_ID'] !== undefined,
  });
}

export async function POST(request: Request): Promise<Response> {
  const env = process.env;
  const { code, verifier, redirectUri } = (await request.json()) as {
    code: string;
    verifier: string;
    redirectUri: string;
  };
  const pair = \`\${encodeURIComponent(env['AW_OIDC_CLIENT_ID'] ?? '')}:\${encodeURIComponent(env['AW_OIDC_CLIENT_SECRET'] ?? '')}\`;
  const answered = await fetch(\`\${env['AW_OIDC_ISSUER_URL'] ?? ''}/token\`, {
    method: 'POST',
    headers: {
      authorization: \`Basic \${Buffer.from(pair).toString('base64')}\`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (answered.status !== 200) {
    const { error } = (await answered.json()) as { error?: string };
    return Response.json({ step: 'token', status: answered.status, error }, { status: 502 });
  }
  const { id_token: idToken } = (await answered.json()) as { id_token: string };
  const aw = createClient({ baseUrl: env['AW_URL'] ?? '', auth: { kind: 'session' } });
  const exchanged = await aw.auth.exchange({
    clientId: env['AW_APP_CLIENT_ID'] ?? '',
    clientSecret: env['AW_APP_CLIENT_SECRET'] ?? '',
    idToken,
  });
  return Response.json({ accessToken: exchanged.access_token, expiresIn: exchanged.expires_in });
}
`;
}

/** An S256 PKCE pair (RFC 7636). */
export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * Sign `email` in at the development issuer through its form, as a browser posts it, and answer
 * the code its redirect carries. Throws on any other answer.
 *
 * @param {{ issuer: string, clientId: string, redirectUri: string, challenge: string }} client
 * @param {{ email: string, password: string }} person
 */
export async function devIssuerCode(client, person) {
  const response = await fetch(`${client.issuer}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: randomBytes(16).toString('base64url'),
      code_challenge: client.challenge,
      code_challenge_method: 'S256',
      email: person.email,
      password: person.password,
    }),
  });
  const location = response.headers.get('location');
  if (response.status !== 302 || location === null)
    throw new Error(`the dev issuer answered ${String(response.status)}, not a redirect`);
  const code = new URL(location).searchParams.get('code');
  if (code === null) throw new Error(`the dev issuer redirected without a code: ${location}`);
  return code;
}

/**
 * `manifest` with every `@indx-workspace/*` dependency pointing at its tarball, and the same map
 * as `overrides`, so a transitive one resolves there too.
 *
 * @param {Record<string, unknown>} manifest @param {Record<string, string>} tarballs
 */
export function withTarballs(manifest, tarballs) {
  /** @type {Record<string, string>} */
  const specs = {};
  for (const [name, tarball] of Object.entries(tarballs)) specs[name] = `file:${tarball}`;
  /** @param {unknown} section */
  const pinned = (section) =>
    section === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(/** @type {Record<string, string>} */ (section)).map(([name, spec]) => [
            name,
            specs[name] ?? spec,
          ]),
        );
  return {
    ...manifest,
    dependencies: pinned(manifest['dependencies']),
    devDependencies: pinned(manifest['devDependencies']),
    overrides: specs,
  };
}

/** @param {number} port */
function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * The first free port from `base`, skipping `taken`. The apps lane picks its ports so too.
 *
 * @param {number} base @param {Set<number>} taken
 */
export async function freePort(base, taken) {
  for (let port = base; port < base + 200; port += 1) {
    if (!taken.has(port) && (await isFree(port))) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`no free port from ${String(base)}`);
}

/**
 * Pack every published package into `directory`: each package's npm name to its tarball. The apps
 * benchmark's `regenerate.mjs` packs the same way.
 *
 * @param {string} directory
 */
export function packPackages(directory) {
  const printed = run(
    process.execPath,
    [
      path.join(ROOT, 'scripts/release/pack-packages.mjs'),
      '--out',
      directory,
      '--packages',
      PUBLISHED_PACKAGES.join(','),
    ],
    { cwd: ROOT, timeoutMs: 600_000 },
  );
  /** @type {Record<string, string>} */
  const tarballs = {};
  for (const tarball of printed.trim().split(/\r?\n/u)) {
    const manifest = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']));
    tarballs[manifest.name] = tarball;
  }
  return tarballs;
}

/** @param {string} file @param {(value: Record<string, unknown>) => Record<string, unknown>} change */
function editJson(file, change) {
  writeFileSync(
    file,
    `${JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8'))), null, 2)}\n`,
  );
}

/** @param {string} cwd @param {NodeJS.ProcessEnv} env */
function npmInstall(cwd, env) {
  run('npm', ['install', '--no-audit', '--no-fund'], { cwd, env, timeoutMs: 900_000 });
}

/**
 * `aw dev` in `cwd`, collecting its output, resolved once `until` holds or rejected when it exits
 * first. `stop()` interrupts it and waits for it to exit. The apps lane starts its apps so too.
 *
 * @param {string} aw @param {string} cwd @param {NodeJS.ProcessEnv} env @param {readonly string[]} args
 */
export function startDev(aw, cwd, env, args) {
  const child = spawn(process.execPath, [aw, 'dev', '--no-open', ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => (output.stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (output.stderr += String(chunk)));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    output,
    /** @param {(output: { stdout: string, stderr: string }) => boolean} until */
    async waitFor(until) {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let done = false;
      void exited.then(() => (done = true));
      while (!until(output)) {
        if (done)
          throw new Error(`aw dev exited before it was ready:\n${output.stdout}${output.stderr}`);
        if (Date.now() > deadline) {
          throw new Error(`aw dev was not ready in time:\n${output.stdout}${output.stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** @param {{ stdout: string }} output */
const readyWithApp = ({ stdout }) =>
  /^ {2}app {7}http:\/\/127\.0\.0\.1:\d+$/mu.test(stdout) && /^synced: .*"triage"/mu.test(stdout);

/**
 * Sign in as the bootstrap Owner through the console's form and approve a device code: the page
 * and the person token (`awu_live_…`) `aw login` would hold. The apps lane signs in so too.
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {string} origin @param {{ email: string, password: string }} admin
 */
export async function signIn(browser, origin, admin) {
  const page = await (await browser.newContext({ baseURL: origin })).newPage();
  await page.goto('/signin');
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'));
  const device = await (await fetch(`${origin}/api/auth/cli-device`, { method: 'POST' })).json();
  await page.goto(`/api/auth/cli-verify?code=${encodeURIComponent(device.userCode)}`);
  await page.locator('input[name="confirm"]').check();
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForLoadState();
  // The verify page's policy allows no fetch; the console's own pages do.
  await page.goto('/');
  const issued = await fetch(`${origin}/api/auth/cli-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCode: device.deviceCode }),
  });
  if (issued.status !== 200) throw new Error(`cli-token answered ${String(issued.status)}`);
  const { token } = await issued.json();
  return { page, token };
}

/**
 * Store the app's identity secret `APP_<NAME>_IDENTITY` from the signed-in Owner's console, as the
 * docs say: secrets are an Owner's (spec §21) and `aw dev` holds an Admin key, so it only says
 * which secret to add and where its value is (`.aw/app-identity.json`). Throws when `aw dev` did
 * not say so in `stderr`, or the console refused it. The apps lane stores it so too.
 *
 * @param {import('@playwright/test').Page} page @param {string} project
 * @param {string} appName @param {string} stderr `aw dev`'s standard error so far
 */
export async function storeAppIdentity(page, project, appName, stderr) {
  const identityName = `APP_${appName.toUpperCase().replaceAll('-', '_')}_IDENTITY`;
  if (!stderr.includes(`add ${identityName} under Secrets`)) {
    throw new Error(`aw dev did not say how to add ${identityName}:\n${stderr}`);
  }
  console.log(`== adding ${identityName} as the Owner`);
  const identity = JSON.parse(readFileSync(path.join(project, '.aw/app-identity.json'), 'utf8'));
  const stored = await page.evaluate(
    async ({ name, value }) =>
      (
        await fetch('/api/secrets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, value }),
        })
      ).status,
    { name: identityName, value: identity.secret },
  );
  if (stored !== 201) throw new Error(`POST /api/secrets answered ${String(stored)}`);
}

/**
 * Start `agentName` from the signed-in console and wait until the run ends.
 *
 * @param {import('@playwright/test').Page} page @param {string} agentName
 */
async function runAgent(page, agentName) {
  return page.evaluate(async (name) => {
    const agents = await (await fetch('/api/agents')).json();
    const agent = agents.agents.find(
      (/** @type {{ name: string }} */ entry) => entry.name === name,
    );
    if (agent === undefined) throw new Error(`no agent ${name}`);
    const started = await fetch(`/api/agents/${agent.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Close the ticket.' }),
    });
    const body = await started.json();
    if (started.status >= 300)
      throw new Error(`run start answered ${String(started.status)}: ${JSON.stringify(body)}`);
    const id = body.id ?? body.run?.id;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const current = await (await fetch(`/api/runs/${id}`)).json();
      const status = current.status ?? current.run?.status;
      if (['completed', 'failed', 'cancelled'].includes(status)) return { id, status, current };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`run ${id} did not end`);
  }, agentName);
}

/**
 * Step 6 (issue #2075): the Owner signs in at the development issuer, the app trades the ID token
 * for an `awo_live_` token, and a run started with it is the Owner's. The person token `aw login`
 * holds is still refused on the run route.
 *
 * @param {import('@playwright/test').Page} page the Owner's signed-in console
 * @param {{ origin: string, appOrigin: string, email: string, password: string, personToken: string }} options
 */
async function signInAtDevIssuer(page, options) {
  console.log('== signing the Owner in at the development issuer');
  const route = `${options.appOrigin}/api/e2e-sign-in`;
  const named = await (await fetch(route)).json();
  if (typeof named.issuer !== 'string' || !named.issuer.startsWith('http://127.0.0.1:'))
    throw new Error(`the app has no development issuer: ${JSON.stringify(named)}`);
  if (named.clientId !== APP_NAME || named.appBackend !== true)
    throw new Error(`the app's sign-in is not configured: ${JSON.stringify(named)}`);
  const { verifier, challenge } = pkcePair();
  const redirectUri = `${options.appOrigin}/api/sign-in/callback`;
  const code = await devIssuerCode(
    { issuer: named.issuer, clientId: named.clientId, redirectUri, challenge },
    { email: options.email, password: options.password },
  );
  const exchanged = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier, redirectUri }),
  });
  const answer = await exchanged.json();
  const { accessToken, expiresIn } = answer;
  if (exchanged.status !== 200 || !String(accessToken).startsWith('awo_live_') || expiresIn !== 300)
    throw new Error(
      `the exchange answered ${String(exchanged.status)}: ${JSON.stringify({ ...answer, accessToken: undefined })}`,
    );

  await startRunAsOwner(page, { ...options, accessToken, agentName: 'triage' });
}

/**
 * A run of `agentName` started on the platform with the exchanged `awo_live_` token is the
 * Owner's: its initiating person is the signed-in console's. The person token `aw login` holds
 * is still `401` on the same run route (ADR-0083, ADR-0161 DI12).
 *
 * @param {import('@playwright/test').Page} page the Owner's signed-in console
 * @param {{ origin: string, accessToken: string, personToken: string, agentName: string }} options
 * @returns {Promise<string>} the run's id
 */
async function startRunAsOwner(page, options) {
  const { accessToken } = options;
  const { agentId, ownerId } = await page.evaluate(async (name) => {
    const agents = await (await fetch('/api/agents')).json();
    const me = await (await fetch('/api/me')).json();
    return {
      agentId: agents.agents.find((/** @type {{ name: string }} */ entry) => entry.name === name)
        ?.id,
      ownerId: me.userId,
    };
  }, options.agentName);
  const runs = `${options.origin}/api/agents/${String(agentId)}/runs`;
  const body = JSON.stringify({ prompt: 'Say hello.' });
  const headers = (/** @type {string} */ bearer) => ({
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
  });
  const refused = await fetch(runs, {
    method: 'POST',
    headers: headers(options.personToken),
    body,
  });
  if (refused.status !== 401)
    throw new Error(
      `the person token answered ${String(refused.status)} on the run route, not 401`,
    );
  const started = await fetch(runs, { method: 'POST', headers: headers(accessToken), body });
  const run = await started.json();
  if (started.status !== 202)
    throw new Error(`the run start answered ${String(started.status)}: ${JSON.stringify(run)}`);
  const read = await (
    await fetch(`${options.origin}/api/runs/${String(run.run?.id)}`, {
      headers: headers(accessToken),
    })
  ).json();
  if (read.run?.initiatingUserId !== ownerId)
    throw new Error(
      `the run's initiating person is ${String(read.run?.initiatingUserId)}, not the Owner ${String(ownerId)}`,
    );
  console.log(`== the ${options.agentName} run started through the app is the Owner's`);
  return String(run.run?.id);
}

/**
 * `command` run by the shell in `cwd`: its exit status and output, never thrown.
 *
 * @param {string} command @param {string} cwd @param {NodeJS.ProcessEnv} env
 */
function shell(command, cwd, env) {
  const result = spawnSync('sh', ['-c', command], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * The portal case: the generated portal type-checks and its CI passes, and each planted platform
 * reach makes that CI exit non-zero.
 *
 * @param {string} work @param {string} create @param {Record<string, string>} tarballs
 * @param {NodeJS.ProcessEnv} env
 */
function portalCase(work, create, tarballs, env) {
  console.log('== portal: create --template portal');
  run(process.execPath, [create, PORTAL_PROJECT, '--template', 'portal', '--yes', '--no-install'], {
    cwd: work,
    env,
  });
  const project = path.join(work, PORTAL_PROJECT);
  const manifest = path.join(project, 'package.json');
  if (!readFileSync(path.join(project, 'aw-generated.json'), 'utf8').includes('"app:portal"')) {
    throw new Error('aw-generated.json records no app:portal');
  }
  editJson(manifest, (value) => withTarballs(value, tarballs));
  npmInstall(project, env);
  console.log('== portal: type-checking its pages');
  run('npm', ['install', '--no-audit', '--no-fund', '--save-dev', ...TYPE_CHECK_PACKAGES], {
    cwd: project,
    env,
    timeoutMs: 600_000,
  });
  run('npx', ['--no-install', 'tsc', '--noEmit'], { cwd: project, env });

  const steps = ciRunSteps(readFileSync(path.join(project, APP_CI_WORKFLOW), 'utf8'));
  const [install, imports, packages, ...rest] = steps;
  if (install !== 'npm ci' || imports === undefined || packages === undefined || rest.length > 0) {
    throw new Error(
      `${APP_CI_WORKFLOW} has other steps than install, imports, packages: ${JSON.stringify(steps)}`,
    );
  }
  console.log(`== portal: ${APP_CI_WORKFLOW}, as generated`);
  for (const step of [imports, packages]) {
    const result = shell(step, project, env);
    if (result.status !== 0)
      throw new Error(`${step} exited ${String(result.status)}:\n${result.output}`);
  }

  console.log("== portal: a planted import '@agent-workspace/core' fails the import check");
  const planted = path.join(project, 'app/planted.ts');
  writeFileSync(planted, "import '@agent-workspace/core';\n");
  const refusedImport = shell(imports, project, env);
  rmSync(planted);
  if (
    refusedImport.status === 0 ||
    !refusedImport.output.includes('app-imports-only-published-packages')
  ) {
    throw new Error(`the planted import passed the import check:\n${refusedImport.output}`);
  }

  console.log('== portal: a planted @agent-workspace/core dependency fails the package check');
  const original = readFileSync(manifest, 'utf8');
  editJson(manifest, (value) => ({
    ...value,
    dependencies: {
      .../** @type {Record<string, string>} */ (value['dependencies']),
      '@agent-workspace/core': '0.0.0',
    },
  }));
  const refusedPackage = shell(packages, project, env);
  writeFileSync(manifest, original);
  if (refusedPackage.status === 0 || !refusedPackage.output.includes('@agent-workspace/core')) {
    throw new Error(`the planted dependency passed the package check:\n${refusedPackage.output}`);
  }
  console.log('== portal: generated CI passes, and refuses each planted reach');
  return project;
}

/** How long the portal's sign-in may take to be configured: `aw dev` restarts the app with it. */
const SIGN_IN_READY_TIMEOUT_MS = 180_000;

/**
 * Wait until the app's `GET /api/sign-in` redirects to the issuer: `aw dev` restarts the app with
 * its `app-backend` pair after the first sync (ADR-0161 DI10), and until then the sign-in answers
 * `503 sign_in_not_configured` (or nothing, while the app restarts).
 *
 * @param {string} appOrigin
 */
export async function signInConfigured(appOrigin) {
  const deadline = Date.now() + SIGN_IN_READY_TIMEOUT_MS;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const answered = await fetch(`${appOrigin}/api/sign-in`, {
        redirect: 'manual',
        headers: { accept: 'application/json' },
      });
      if (answered.status === 303) return;
      last = `${String(answered.status)} ${await answered.text()}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`the portal's sign-in was not configured in time: ${last}`);
}

/**
 * The portal signs a person in under `aw dev` (issues #1510 and #2075): `/` shows the sign-in
 * notice, its link leads to `/sign-in` and on to the development issuer's form. A wrong password
 * is refused there and the portal stays signed out; the Owner's password lands on `/` signed in,
 * with the `awo_live_` token in the app's `HttpOnly` cookie. A run started with that token is the
 * Owner's, and signing out clears the cookie.
 *
 * @param {string} project @param {NodeJS.ProcessEnv} env @param {string} scripts
 */
async function portalSignsIn(project, env, scripts) {
  const agentFile = path.join(project, 'agents/assistant.ts');
  writeFileSync(
    agentFile,
    withModel(readFileSync(agentFile, 'utf8'), `scripted:${SCRIPTED_MODEL}`),
  );
  const aw = path.join(project, 'node_modules/@indx-workspace/aw/dist/index.js');
  const taken = new Set();
  const ports = {
    web: await freePort(3700, taken),
    gateway: await freePort(14700, taken),
    runner: await freePort(18700, taken),
    database: await freePort(26700, taken),
  };
  const origin = `http://127.0.0.1:${String(ports.web)}`;
  const dev = startDev(
    aw,
    project,
    {
      ...env,
      AW_SCRIPTED_MODELS_DIR: scripts,
      GATEWAY_PORT: String(ports.gateway),
      RUNNER_PORT: String(ports.runner),
      AW_DATABASE_PORT: String(ports.database),
    },
    ['--port', String(ports.web)],
  );
  /** @type {import('@playwright/test').Browser | undefined} */
  let browser;
  try {
    console.log('== portal: aw dev');
    await dev.waitFor(readyWithAnyApp);
    const appOrigin = /^ {2}app {7}(http:\/\/127\.0\.0\.1:\d+)$/mu.exec(dev.output.stdout)?.[1];
    const secrets = JSON.parse(
      readFileSync(path.join(project, '.agent-workspace/secrets/local-secrets.json'), 'utf8'),
    );
    const email = /bootstrapAdmin: (\S+)/u.exec(
      readFileSync(path.join(project, 'agent-workspace.yaml'), 'utf8'),
    )?.[1];
    if (appOrigin === undefined || email === undefined)
      throw new Error('aw dev named no app, or agent-workspace.yaml no bootstrapAdmin');
    await signInConfigured(appOrigin);

    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
    const owner = await signIn(browser, origin, {
      email,
      password: secrets.BOOTSTRAP_ADMIN_PASSWORD,
    });
    const portal = await browser.newContext({ baseURL: appOrigin, locale: 'en-US' });
    const page = await portal.newPage();
    page.setDefaultTimeout(120_000);
    const personCookie = async () =>
      (await portal.cookies(appOrigin)).find((cookie) => cookie.name === 'aw_user_token');

    console.log('== portal: / asks to sign in, and its link leads to /sign-in');
    await page.goto('/');
    await page.getByRole('heading', { name: 'Sign in required' }).waitFor();
    await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/sign-in');
    await page.getByRole('heading', { name: 'Sign in to portal' }).waitFor();
    await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/authorize');

    console.log('== portal: a wrong password is refused at the issuer and stays signed out');
    await page.getByLabel('Email').fill(email);
    await page
      .getByLabel('Local console password')
      .fill(`not-${String(secrets.BOOTSTRAP_ADMIN_PASSWORD)}`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').getByText('That email or password was not accepted.').waitFor();
    if (new URL(page.url()).pathname !== '/authorize' || (await personCookie()) !== undefined)
      throw new Error(`a wrong password signed the portal in: ${page.url()}`);

    console.log("== portal: the Owner's password signs the portal in");
    await page.getByLabel('Local console password').fill(secrets.BOOTSTRAP_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.origin === appOrigin && url.pathname === '/');
    await page.getByRole('heading', { name: 'portal', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sign out' }).waitFor();
    const signedIn = await personCookie();
    if (signedIn === undefined || !signedIn.value.startsWith('awo_live_') || !signedIn.httpOnly)
      throw new Error("the portal's cookie holds no HttpOnly awo_live_ token");

    const runId = await startRunAsOwner(owner.page, {
      origin,
      accessToken: signedIn.value,
      personToken: owner.token,
      agentName: 'assistant',
    });

    // ADR-0161's run-list amendment (#1530): the Dashboard and /runs read the run list with the
    // person's awo_live_ token, so the run just started is listed, never a "not available" line.
    console.log('== portal: the Dashboard and /runs list the run as the signed-in person');
    await page.goto('/');
    await page
      .getByRole('region', { name: 'Recent runs' })
      .getByRole('link', { name: `Run ${runId}` })
      .waitFor();
    await page.goto('/runs');
    await page.getByRole('heading', { name: 'Runs', level: 1 }).waitFor();
    await page.getByRole('link', { name: `Run ${runId}` }).waitFor();

    console.log('== portal: signing out clears the cookie');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL((url) => url.pathname === '/sign-in');
    if ((await personCookie()) !== undefined) throw new Error('sign-out left the cookie');
    console.log('== portal: signed in under aw dev, and the run was the Owner’s');
  } catch (error) {
    console.error(`aw dev stdout:\n${dev.output.stdout}\naw dev stderr:\n${dev.output.stderr}`);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await dev.stop();
  }
}

/**
 * The preset cases (issue #1511): each `--template` preset, created in the directory its reference
 * app uses, so the app is named after the directory and never the template id.
 */
export const TEMPLATE_CASES = Object.freeze({
  'team-chat': 'chat',
  wiki: 'wiki',
  crm: 'crm',
  'service-desk': 'desk',
});

/**
 * The follow-up commands a preset's README lists: every line that starts `npx aw `, in order, as
 * `sh` runs them.
 *
 * @param {string} readme
 */
export function readmeCommands(readme) {
  return readme.split('\n').filter((line) => line.startsWith('npx aw '));
}

/** @param {NodeJS.ProcessEnv} env */
const buildEnv = (env) => ({ ...env, NEXT_TELEMETRY_DISABLED: '1' });

/**
 * A preset case: `create <dir> --template <id> --yes` on the tarballs, `npx tsc --noEmit` and
 * `next build` before any of the README's commands has run. For `crm`, every command of its README
 * (the reference app's `commands.sh` after `npm create`) then runs without a path conflict, and the
 * app type-checks again.
 *
 * @param {string} work @param {string} create @param {Record<string, string>} tarballs
 * @param {NodeJS.ProcessEnv} env @param {keyof typeof TEMPLATE_CASES} directory
 */
function templateCase(work, create, tarballs, env, directory) {
  const template = TEMPLATE_CASES[directory];
  console.log(`== ${directory}: create --template ${template}`);
  run(process.execPath, [create, directory, '--template', template, '--yes', '--no-install'], {
    cwd: work,
    env,
  });
  const project = path.join(work, directory);
  const recorded = readFileSync(path.join(project, 'aw-generated.json'), 'utf8');
  for (const key of [`app:${directory}`, `project:${directory}`]) {
    if (!recorded.includes(`"${key}"`)) throw new Error(`aw-generated.json records no ${key}`);
  }
  editJson(path.join(project, 'package.json'), (value) => withTarballs(value, tarballs));
  npmInstall(project, env);
  run('npm', ['install', '--no-audit', '--no-fund', '--save-dev', ...TYPE_CHECK_PACKAGES], {
    cwd: project,
    env,
    timeoutMs: 600_000,
  });
  console.log(`== ${directory}: type-checking and building it as created`);
  run('npx', ['--no-install', 'tsc', '--noEmit'], { cwd: project, env });
  run('npx', ['--no-install', 'next', 'build'], {
    cwd: project,
    env: buildEnv(env),
    timeoutMs: 900_000,
  });
  if (template === 'crm') {
    const commands = readmeCommands(readFileSync(path.join(project, 'README.md'), 'utf8'));
    if (commands.length === 0) throw new Error('the crm README lists no npx aw commands');
    for (const command of commands) {
      console.log(`== ${directory}: ${command}`);
      const result = shell(command, project, env);
      if (result.status !== 0)
        throw new Error(`${command} exited ${String(result.status)}:\n${result.output}`);
    }
    run('npx', ['--no-install', 'tsc', '--noEmit'], { cwd: project, env });
  }
  console.log(`== ${directory} case passed`);
  return project;
}

/** @param {{ stdout: string }} output */
const readyWithAnyApp = ({ stdout }) =>
  /^ {2}app {7}http:\/\/127\.0\.0\.1:\d+$/mu.test(stdout) && /^synced: /mu.test(stdout);

/**
 * The wiki's migration applied: `aw dev` in the wiki project until it is ready, and the signed-in
 * person's `GET /api/pages` answers 200 with no pages.
 *
 * @param {string} project @param {NodeJS.ProcessEnv} env @param {string} scripts
 */
async function wikiServes(project, env, scripts) {
  const aw = path.join(project, 'node_modules/@indx-workspace/aw/dist/index.js');
  const taken = new Set();
  const ports = {
    web: await freePort(3500, taken),
    gateway: await freePort(14500, taken),
    runner: await freePort(18500, taken),
    database: await freePort(26500, taken),
  };
  const dev = startDev(
    aw,
    project,
    {
      ...env,
      AW_SCRIPTED_MODELS_DIR: scripts,
      GATEWAY_PORT: String(ports.gateway),
      RUNNER_PORT: String(ports.runner),
      AW_DATABASE_PORT: String(ports.database),
    },
    ['--port', String(ports.web)],
  );
  /** @type {import('@playwright/test').Browser | undefined} */
  let browser;
  try {
    console.log('== wiki: aw dev');
    await dev.waitFor(readyWithAnyApp);
    const appOrigin = /^ {2}app {7}(http:\/\/127\.0\.0\.1:\d+)$/mu.exec(dev.output.stdout)?.[1];
    const secrets = JSON.parse(
      readFileSync(path.join(project, '.agent-workspace/secrets/local-secrets.json'), 'utf8'),
    );
    const email = /bootstrapAdmin: (\S+)/u.exec(
      readFileSync(path.join(project, 'agent-workspace.yaml'), 'utf8'),
    )?.[1];
    if (appOrigin === undefined || email === undefined)
      throw new Error('aw dev named no app, or agent-workspace.yaml no bootstrapAdmin');
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
    const { token } = await signIn(browser, `http://127.0.0.1:${String(ports.web)}`, {
      email,
      password: secrets.BOOTSTRAP_ADMIN_PASSWORD,
    });
    const listed = await fetch(`${appOrigin}/api/pages`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await listed.json();
    if (listed.status !== 200 || !Array.isArray(body.items) || body.items.length !== 0) {
      throw new Error(
        `GET /api/pages answered ${String(listed.status)}: ${JSON.stringify(body)}, not 200 with no pages`,
      );
    }
    console.log('== wiki: GET /api/pages answers 200 with no pages');
  } catch (error) {
    console.error(`aw dev stdout:\n${dev.output.stdout}\naw dev stderr:\n${dev.output.stderr}`);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await dev.stop();
  }
}

async function main() {
  const cases = casesOf(process.argv.slice(2));
  const budget = positiveIntegerVariable('APP_KIT_TIMEOUT_MS', 40 * 60_000);
  const guard = setTimeout(() => {
    console.error(`app-kit E2E: the run did not finish within ${String(budget)} ms`);
    process.exit(1);
  }, budget);
  guard.unref();
  const keep = process.env['APP_KIT_WORK_DIR'] !== undefined;
  const work = path.resolve(
    process.env['APP_KIT_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'app-kit-e2e-')),
  );
  const home = path.join(work, 'home');
  const scripts = path.join(work, 'scripted-models');
  mkdirSync(home, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  const scriptFile = path.join(scripts, `${SCRIPTED_MODEL}.json`);
  writeFileSync(scriptFile, JSON.stringify(closeTicketScript(undefined)));
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: process.env['PATH'],
    HOME: home,
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    TMPDIR: process.env['TMPDIR'],
    NO_COLOR: '1',
    npm_config_cache:
      process.env['npm_config_cache'] ?? path.join(process.env['HOME'] ?? home, '.npm'),
  };

  console.log(`== packing the @indx-workspace packages into ${work}/packs`);
  const tarballs = packPackages(path.join(work, 'packs'));
  const consumer = path.join(work, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify(withTarballs({ name: 'consumer', private: true, type: 'module', dependencies: Object.fromEntries(Object.keys(tarballs).map((name) => [name, '*'])) }, tarballs), null, 2)}\n`,
  );
  npmInstall(consumer, env);

  const create = path.join(consumer, 'node_modules/@indx-workspace/create/dist/index.js');
  if (cases.includes('portal')) {
    await portalSignsIn(portalCase(work, create, tarballs, env), env, scripts);
    console.log('== portal case passed');
  }
  for (const directory of /** @type {(keyof typeof TEMPLATE_CASES)[]} */ (
    Object.keys(TEMPLATE_CASES)
  )) {
    if (!cases.includes(directory)) continue;
    const project = templateCase(work, create, tarballs, env, directory);
    if (directory === 'wiki') await wikiServes(project, env, scripts);
  }
  if (!cases.includes('desk')) {
    console.log('== app-kit E2E passed');
    if (!keep) removeWorkDirectory(work);
    return;
  }

  console.log('== generating the project, its app, a resource and an agent');
  run(process.execPath, [create, PROJECT_NAME, '--yes', '--no-install', '--no-start'], {
    cwd: work,
    env,
  });
  const project = path.join(work, PROJECT_NAME);
  const manifest = path.join(project, 'package.json');
  editJson(manifest, (value) => withTarballs(value, tarballs));
  npmInstall(project, env);
  const aw = path.join(project, 'node_modules/@indx-workspace/aw/dist/index.js');
  run(process.execPath, [aw, 'generate', 'app', APP_NAME], { cwd: project, env });
  editJson(manifest, (value) => withTarballs(value, tarballs));
  npmInstall(project, env);
  run(
    process.execPath,
    [aw, 'generate', 'resource', 'ticket', 'title:text', 'status:enum(new,closed)'],
    {
      cwd: project,
      env,
    },
  );
  const resourceFile = path.join(project, 'resources/ticket.ts');
  writeFileSync(resourceFile, withAgentWrite(readFileSync(resourceFile, 'utf8')));
  run(process.execPath, [aw, 'generate', 'agent', 'triage', '--tools', 'ticket'], {
    cwd: project,
    env,
  });
  // Both agents (create's `assistant` and the generated `triage`) on the scripted model.
  for (const name of ['assistant', 'triage']) {
    const agentFile = path.join(project, 'agents', `${name}.ts`);
    writeFileSync(
      agentFile,
      withModel(readFileSync(agentFile, 'utf8'), `scripted:${SCRIPTED_MODEL}`),
    );
  }
  console.log('== type-checking the generated app');
  // `aw generate app` pins no TypeScript (`next dev` would install it on its first start), so the
  // developer's type check installs the versions this repository builds the app kit with.
  run('npm', ['install', '--no-audit', '--no-fund', '--save-dev', ...TYPE_CHECK_PACKAGES], {
    cwd: project,
    env,
    timeoutMs: 600_000,
  });
  run('npx', ['--no-install', 'tsc', '--noEmit'], { cwd: project, env });
  // Planted after the developer's type check: the E2E's own route, never a generated file.
  mkdirSync(path.dirname(path.join(project, SIGN_IN_PROOF_ROUTE)), { recursive: true });
  writeFileSync(path.join(project, SIGN_IN_PROOF_ROUTE), signInProofRoute());

  const taken = new Set();
  const ports = {
    web: await freePort(3300, taken),
    gateway: await freePort(14300, taken),
    runner: await freePort(18300, taken),
    database: await freePort(26300, taken),
  };
  const devEnv = {
    ...env,
    AW_SCRIPTED_MODELS_DIR: scripts,
    GATEWAY_PORT: String(ports.gateway),
    RUNNER_PORT: String(ports.runner),
    AW_DATABASE_PORT: String(ports.database),
  };
  const devArgs = ['--port', String(ports.web)];
  const origin = `http://127.0.0.1:${String(ports.web)}`;
  const databaseUrl = `postgresql://${DATABASE_CREDENTIALS}@127.0.0.1:${String(ports.database)}/postgres`;

  console.log(`== aw dev on ${origin}`);
  const first = startDev(aw, project, devEnv, devArgs);
  /** @type {import('pg').Client | undefined} */
  let database;
  /** @type {import('@playwright/test').Browser | undefined} */
  let browser;
  try {
    await first.waitFor(readyWithApp);
    const appOrigin =
      /^ {2}app {7}(http:\/\/127\.0\.0\.1:\d+)$/mu.exec(first.output.stdout)?.[1] ?? '';
    console.log(`== the app is on ${appOrigin}`);
    const secrets = JSON.parse(
      readFileSync(path.join(project, '.agent-workspace/secrets/local-secrets.json'), 'utf8'),
    );
    const email = /bootstrapAdmin: (\S+)/u.exec(
      readFileSync(path.join(project, 'agent-workspace.yaml'), 'utf8'),
    )?.[1];
    if (email === undefined) throw new Error('agent-workspace.yaml names no bootstrapAdmin');
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
    const { page, token } = await signIn(browser, origin, {
      email,
      password: secrets.BOOTSTRAP_ADMIN_PASSWORD,
    });

    await storeAppIdentity(page, project, APP_NAME, first.output.stderr);

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
    const outcome = await runAgent(page, 'triage');
    if (outcome.status !== 'completed')
      throw new Error(`the run ended ${outcome.status}: ${JSON.stringify(outcome.current)}`);

    const pg = createRequire(manifest)('pg');
    database = new pg.Client({ connectionString: databaseUrl });
    // A runtime that stops ends the connection: a failure then, never an unhandled event.
    database.on('error', () => undefined);
    await database.connect();
    const row = await database.query(
      `select status from "app_${APP_NAME}"."tickets" where id = $1`,
      [ticket.id],
    );
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

    await signInAtDevIssuer(page, {
      origin,
      appOrigin,
      email,
      password: secrets.BOOTSTRAP_ADMIN_PASSWORD,
      personToken: token,
    });
    await database.end();
    database = undefined;
    await browser.close();
    browser = undefined;
    await first.stop();

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
      database = undefined;
      await second.stop();
    }
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

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
