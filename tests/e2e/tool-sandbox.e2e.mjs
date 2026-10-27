#!/usr/bin/env node
/* global console, fetch */
/**
 * The tool-sandbox E2E (issue #847, ADR-0118): a code tool, end to end, on this checkout's own
 * `compose.yaml` with the tool sandbox turned on.
 *
 *   pnpm build && node tests/e2e/tool-sandbox.e2e.mjs
 *
 * 1. Build the three images compose does not build (runtime, egress proxy, tool host), then bring
 *    the stack up with `TOOL_HOST_IMAGE` set and a fake Anthropic API (`tool-sandbox-provider.mjs`)
 *    answering as `api.anthropic.com` on the stack's network.
 * 2. Set the workspace up through the API and mint an `ak_live_` key for `aw`.
 * 3. In a project of one agent and one code tool, `aw push --yes`: it must create the `aw-dev-tools`
 *    connector and a version that pins the tool's bundle, with nothing seeded by hand.
 * 4. Start a run. The fake model calls the tool; the tool runs in the session's tool sandbox, behind
 *    the gateway's `/v1/tool-sandbox/mcp` route; the run completes with the tool's data in its reply.
 * 5. What the tool reported from inside its sandbox (ADR-0118 TS3-TS5): the secret it declared,
 *    set through the API, is in its environment; `DATABASE_URL`, which the web service holds and
 *    the tool does not declare, is not; the egress proxy lets its declared host through and refuses
 *    `example.com`. The tool sandbox's bearer, derived from the e2e's own gateway signing secret,
 *    is in neither the agent runtime container's environment nor its files.
 * 6. `aw promote --yes` moves `production` to the code-tool version.
 *
 * What is not run here: the same push against a deployment with the sandbox off, which refuses by
 * name (`code_tool_needs_host`); `aw`'s and the server's own tests cover it without a Docker daemon.
 *
 * It needs Docker with Compose and `openssl`, and starts and removes containers, networks and
 * volumes of the project `aw-tool-sandbox-e2e` and every runtime or tool-host container on the
 * daemon: run it against a disposable daemon. Environment: `TS_WORK_DIR` (default: a new temporary
 * directory), `TS_WEB_PORT` (3000), `TS_CONTROL_PORT` (18082), `TS_SKIP_IMAGE_BUILD` (set: reuse
 * the three images already on the daemon).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

// The gateway's own derivation of the tool sandbox bearer (ADR-0118 TS3), built by `pnpm build`.
import { toolSandboxRunToken } from '@agent-workspace/gateway/tokens';

import { nodeImageOf } from '../generated-project/run.mjs';
import {
  FAKE_PROVIDER_HOST,
  parseDotEnv,
  run,
  writeFakeProviderFixture,
} from '../generated-project/project.mjs';
import { StackClient, assistantText, terminalStatus } from '../generated-project/stack-api.mjs';
import { IMAGES, composeBuildServices, docker } from './tool-sandbox-images.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PROJECT = 'aw-tool-sandbox-e2e';
const AW_BIN = path.join(ROOT, 'packages/aw/dist/index.js');
export const PROVIDER_SCRIPT = path.join(import.meta.dirname, 'tool-sandbox-provider.mjs');
/** `TOOL_SANDBOX_CONNECTOR_URL` (`@indx-workspace/contracts/tool-connectors`). */
export const TOOL_HOST_URL = 'https://tool-sandbox.invalid/mcp';
export const TOOL_NAME = 'getOrderByOrderNumber';
/** The secret the tool declares; its value is set through the API. */
export const DECLARED_SECRET = 'E2E_DECLARED';
/**
 * The host the tool declares, probed over plain HTTP so the proxy's own refusal is readable. The
 * proxy resolves it on its own outbound network, where it is the real host: the fake behind that
 * name lives on the stack's private network, which the proxy refuses to dial by design.
 */
export const ALLOWED_HOST = FAKE_PROVIDER_HOST;

const AGENT = `import { defineAgent } from '@indx-workspace/sdk/define';
import getOrder from '../tools/get-order.ts';

export default defineAgent({
  name: 'assistant',
  instructions: 'Look up the order the person names with the tool.',
  model: 'anthropic default',
  tools: [getOrder],
});
`;

/** @param {string} network the declaration's `allowedDomains` line, or '' for a tool with no network */
const declarationOf = (
  network,
) => `import { defineTool, secret, z } from '@indx-workspace/sdk/define';

export default defineTool({
  name: '${TOOL_NAME}',
  description: 'Look up an order by its number',
  input: z.object({ orderNumber: z.string() }),
  run: './tools/get-order.run.ts',
  secrets: [secret('${DECLARED_SECRET}')],${network}
});
`;

export const DECLARATION = declarationOf(`\n  allowedDomains: ['${ALLOWED_HOST}'],`);

/**
 * The same tool with no network (ADR-0118 TS5), for a tool sandbox that cannot enforce a domain
 * allow-list: E2B runs a tool sandbox with network `none` or `open` only (ADR-0132).
 */
export const OFFLINE_DECLARATION = declarationOf('');

/** The offline tool's run file: the data and the declared secret, no egress probes. */
export const OFFLINE_RUN_FILE = `import type { ToolRun } from '@indx-workspace/sdk/define';
import type getOrder from './get-order.ts';

const run: ToolRun<typeof getOrder> = async ({ orderNumber }) => {
  const facts = [
    \`declared=\${process.env['${DECLARED_SECRET}'] ?? 'absent'}\`,
    \`database_url=\${process.env['DATABASE_URL'] === undefined ? 'absent' : 'present'}\`,
  ];
  return { orderNumber, note: \`order-data-\${orderNumber} \${facts.join(' ')}\` };
};
export default run;
`;

// Each probe answers reached:<status>, denied:<the proxy's reason> or error:<code>. It uses node:http,
// which sends a plain-HTTP request to HTTP_PROXY in absolute form (NODE_USE_ENV_PROXY), so the
// proxy's own 403 body is readable; fetch tunnels every request with CONNECT and turns a refused
// tunnel into a bare error (the R-14 research note, finding 5).
export const RUN_FILE = `import { request } from 'node:http';

import type { ToolRun } from '@indx-workspace/sdk/define';
import type getOrder from './get-order.ts';

function probe(url: string): Promise<string> {
  return new Promise((resolve) => {
    const outgoing = request(url, { timeout: 10_000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        if (!body.includes('egress_denied')) resolve(\`reached:\${String(response.statusCode)}\`);
        else resolve(\`denied:\${String((JSON.parse(body) as { reason?: unknown }).reason)}\`);
      });
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('timeout')));
    outgoing.on('error', (error: Error & { code?: unknown }) => {
      resolve(\`error:\${String(error.code ?? error.message)}\`);
    });
    outgoing.end();
  });
}

const run: ToolRun<typeof getOrder> = async ({ orderNumber }) => {
  const [allowed, refused] = await Promise.all([
    probe('http://${ALLOWED_HOST}/'),
    probe('http://example.com/'),
  ]);
  const facts = [
    \`declared=\${process.env['${DECLARED_SECRET}'] ?? 'absent'}\`,
    \`database_url=\${process.env['DATABASE_URL'] === undefined ? 'absent' : 'present'}\`,
    \`allowed=\${allowed}\`,
    \`refused=\${refused}\`,
  ];
  return { orderNumber, note: \`order-data-\${orderNumber} \${facts.join(' ')}\` };
};
export default run;
`;

/**
 * The `AW_STORAGE_URL` `.env.example` gives the bundled SeaweedFS, which `compose.yaml` requires.
 * Read from that file so the e2e stack and a copied `.env` name the same store.
 *
 * @param {string} [root] the checkout holding `.env.example`
 */
export function bundledStorageUrl(root = ROOT) {
  const url = parseDotEnv(readFileSync(path.join(root, '.env.example'), 'utf8'))['AW_STORAGE_URL'];
  if (url === undefined || url === '') throw new Error('.env.example sets no AW_STORAGE_URL');
  return url;
}

/**
 * The `--env-file` the e2e brings `compose.yaml` up with.
 *
 * @param {{ adminEmail: string, adminPassword: string, webPort: number, dockerGid: number, storageUrl: string }} options
 */
export function stackEnv({ adminEmail, adminPassword, webPort, dockerGid, storageUrl }) {
  return [
    'DATABASE_URL=postgres://agent_workspace:agent_workspace@postgres:5432/agent_workspace',
    `MASTER_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
    `AW_STORAGE_URL=${storageUrl}`,
    'OBJECT_STORAGE_ACCESS_KEY_ID=agent_workspace',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY=agent_workspace',
    `BOOTSTRAP_ADMIN=${adminEmail}`,
    `BOOTSTRAP_ADMIN_PASSWORD=${adminPassword}`,
    `SESSION_SECRET=${randomBytes(24).toString('hex')}`,
    `RUNNER_MANAGER_TOKEN=${randomBytes(24).toString('hex')}`,
    'GATEWAY_PRICING_JSON={"version":"unconfigured","models":{"disabled:unconfigured":{"inputUsdPerMillion":"0","outputUsdPerMillion":"0"}}}',
    'TOOL_HOST_IMAGE=agent-workspace/tool-host:dev',
    `WEB_PORT=${String(webPort)}`,
    `DOCKER_GID=${String(dockerGid)}`,
    '',
  ].join('\n');
}

/** @param {string} name */
function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

/** @param {string} message @param {boolean} ok */
function check(ok, message) {
  if (!ok) throw new Error(`E2E assertion failed: ${message}`);
  console.log(`ok: ${message}`);
}

/** @param {readonly string[]} args */
/** @param {readonly string[]} args @returns {string} what the command printed */
function dockerOutput(args) {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed`);
  return result.stdout;
}

function composeOverride({ nodeImage, controlPort, fixture, gatewaySecret }) {
  // The web service derives the tool sandbox's bearer from this secret and the gateway recomputes
  // it (ADR-0118 TS3); the E2E supplies it so it can look for that bearer itself.
  const trust = `      EGRESS_ALLOW_HOSTS: ${FAKE_PROVIDER_HOST}
      NODE_EXTRA_CA_CERTS: /e2e/ca.pem
      GATEWAY_TOKEN_SECRET: ${gatewaySecret}
    volumes:
      - ${fixture}/ca.pem:/e2e/ca.pem:ro
    depends_on:
      fake-anthropic: { condition: service_healthy }`;
  return `# Written by tests/e2e/tool-sandbox.e2e.mjs; not part of the deployment.
services:
  fake-anthropic:
    image: ${nodeImage}
    command: [node, /repo/tests/e2e/tool-sandbox-provider.mjs]
    environment:
      FAKE_ANTHROPIC_TLS_CERT: /e2e/${FAKE_PROVIDER_HOST}.pem
      FAKE_ANTHROPIC_TLS_KEY: /e2e/${FAKE_PROVIDER_HOST}.key
    volumes:
      - ${fixture}:/e2e:ro
      - ${path.join(ROOT, 'tests')}:/repo/tests:ro
    ports: ['127.0.0.1:${String(controlPort)}:8081']
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 3s
      retries: 30
    networks:
      agent-workspace: { aliases: [${FAKE_PROVIDER_HOST}] }
  gateway:
    environment:
${trust}
  web:
    environment:
${trust}
  # Nothing here reaches SeaweedFS from the host, and another project on the daemon may hold 8333.
  seaweedfs:
    ports: !reset []
networks:
  # The runner only attaches runtime networks that carry the ownership label.
  runtime-control:
    labels:
      agent-workspace.runtime: docker-network
`;
}

async function main() {
  const work = path.resolve(
    process.env['TS_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'tool-sandbox-e2e-')),
  );
  const webPort = Number(required('TS_WEB_PORT', '3000'));
  const controlPort = Number(required('TS_CONTROL_PORT', '18082'));
  const baseUrl = `http://127.0.0.1:${String(webPort)}`;
  const adminEmail = 'admin@example.com';
  const adminPassword = randomBytes(12).toString('hex');
  const providerKey = `sk-ant-e2e-fake-${randomBytes(6).toString('hex')}`;
  const gatewaySecret = randomBytes(32).toString('hex');
  const declaredValue = `e2e-declared-${randomBytes(6).toString('hex')}`;

  mkdirSync(work, { recursive: true });
  writeFakeProviderFixture(work, PROVIDER_SCRIPT);
  const fixture = path.join(work, '.e2e');
  writeFileSync(
    path.join(work, 'compose.override.yaml'),
    composeOverride({
      nodeImage: nodeImageOf(readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')),
      controlPort,
      fixture,
      gatewaySecret,
    }),
  );
  writeFileSync(
    path.join(work, 'stack.env'),
    stackEnv({
      adminEmail,
      adminPassword,
      webPort,
      dockerGid: statSync('/var/run/docker.sock').gid,
      storageUrl: bundledStorageUrl(),
    }),
  );
  const compose = (/** @type {readonly string[]} */ args) =>
    docker([
      'compose',
      '--project-name',
      PROJECT,
      '--project-directory',
      ROOT,
      '--env-file',
      path.join(work, 'stack.env'),
      '-f',
      path.join(ROOT, 'compose.yaml'),
      '-f',
      path.join(work, 'compose.override.yaml'),
      ...args,
    ]);

  // The project: one agent, one code tool. The SDK is linked from this checkout, as a user's
  // node_modules would hold it.
  const project = path.join(work, 'project');
  mkdirSync(path.join(project, 'agents'), { recursive: true });
  mkdirSync(path.join(project, 'tools'), { recursive: true });
  mkdirSync(path.join(project, 'node_modules/@indx-workspace'), { recursive: true });
  for (const name of ['sdk', 'contracts']) {
    symlinkSync(
      path.join(ROOT, 'packages', name),
      path.join(project, 'node_modules/@indx-workspace', name),
    );
  }
  writeFileSync(
    path.join(project, 'package.json'),
    '{ "name": "tool-sandbox-e2e", "type": "module" }\n',
  );
  writeFileSync(path.join(project, 'agents/assistant.ts'), AGENT);
  writeFileSync(path.join(project, 'tools/get-order.ts'), DECLARATION);
  writeFileSync(path.join(project, 'tools/get-order.run.ts'), RUN_FILE);

  let failed = true;
  try {
    if (process.env['TS_SKIP_IMAGE_BUILD'] === undefined) {
      for (const [dockerfile, target, tag, args] of IMAGES) {
        docker(['build', '--file', dockerfile, '--target', target, ...args, '--tag', tag, '.']);
      }
    }
    compose(['build', ...composeBuildServices()]);
    compose(['up', '--detach']);

    const client = new StackClient(baseUrl);
    for (let attempt = 0; ; attempt += 1) {
      const ready = await fetch(`${baseUrl}/setup`, { redirect: 'manual' }).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) break;
      if (attempt > 180) throw new Error('the web service did not answer /setup within 6 minutes');
      await delay(2_000);
    }

    const setup = await client.setup({
      provider: 'anthropic',
      providerApiKey: providerKey,
      runtime: 'docker',
      adminEmail,
      adminPassword,
      agentName: 'E2E setup agent',
      agentInstructions: 'Answer briefly.',
    });
    check(
      setup.status === 201,
      `setup answered ${String(setup.status)} ${setup.text.slice(0, 200)}`,
    );
    const minted = await client.request('/api/api-keys', {
      method: 'POST',
      body: { name: 'tool-sandbox-e2e', role: 'admin', expiresAt: null },
    });
    const apiKey = /** @type {{ key: string }} */ (minted.json).key;
    check(apiKey.startsWith('ak_live_'), 'an API key was minted for aw');

    const aw = (/** @type {readonly string[]} */ args) =>
      run(process.execPath, [AW_BIN, ...args], {
        cwd: project,
        env: { ...process.env, AGENT_WORKSPACE_URL: baseUrl, AGENT_WORKSPACE_API_KEY: apiKey },
        timeoutMs: 180_000,
      });

    // The secret the tool declares, set through the API before the run resolves it.
    const created = await client.request('/api/secrets', {
      method: 'POST',
      body: { name: DECLARED_SECRET, value: declaredValue },
    });
    check(
      created.status === 201,
      `the declared secret was set (${String(created.status)} ${created.text.slice(0, 200)})`,
    );

    // Acceptance 1: push makes the tool-host connector and the version with the bundle digest.
    aw(['push', '--yes']);
    const connectors = /** @type {{ connectors: { id: string, name: string, url?: string }[] }} */ (
      (await client.request('/api/connectors')).json
    ).connectors;
    const devTools = connectors.find((c) => c.name === 'aw-dev-tools' && c.url === TOOL_HOST_URL);
    check(devTools !== undefined, 'aw push created the aw-dev-tools connector at the reserved URL');
    const agents =
      /** @type {{ agents: { id: string, name: string, runtimeProfileId?: string | null }[] }} */ (
        (await client.request('/api/agents')).json
      ).agents;
    const agent = agents.find((candidate) => candidate.name === 'assistant');
    check(agent !== undefined, 'aw push created the agent');
    // A pushed definition names no runtime profile and a runtime has no inheritance layer, so the
    // pushed agent runs on the profile setup seeded for its own agent.
    const profileId = agents.find((a) => a.name === 'E2E setup agent')?.runtimeProfileId;
    check(typeof profileId === 'string', 'setup seeded a runtime profile');
    const attached = await client.request(`/api/agents/${agent?.id ?? ''}`, {
      method: 'PATCH',
      body: { runtimeProfileId: profileId },
    });
    check(
      attached.status === 200,
      `the runtime profile was attached (${String(attached.status)} ${attached.text.slice(0, 200)})`,
    );
    const versions = JSON.parse(aw(['versions', '--json']));
    check(
      versions.pointers.some(
        (/** @type {{ environment: string }} */ p) => p.environment === 'local',
      ),
      'aw push moved local to the new version',
    );

    // The run: the model asks for the tool, the tool sandbox answers, the run completes.
    const nonce = `e2e-nonce-ts${randomBytes(4).toString('hex')}`;
    const started = await client.request(`/api/agents/${agent?.id ?? ''}/runs`, {
      method: 'POST',
      body: { prompt: `Please look up order ${nonce}.` },
    });
    check(
      started.status === 202,
      `the run was accepted (${String(started.status)} ${started.text.slice(0, 200)})`,
    );
    const runId = /** @type {{ run: { id: string } }} */ (started.json).run.id;
    const frames = await client.runFrames(runId);
    check(
      terminalStatus(frames) === 'completed',
      `the run completed (${JSON.stringify(frames.slice(-3))})`,
    );
    const reply = assistantText(frames);
    check(reply.includes(`order-data-${nonce}`), "the reply carries the code tool's data");
    // What the tool saw inside its sandbox (TS4, TS5).
    check(
      reply.includes(`declared=${declaredValue}`),
      'the tool read the secret it declared, set through the API',
    );
    check(
      reply.includes('database_url=absent'),
      'the tool does not see DATABASE_URL, which it never declared',
    );
    check(
      /allowed=reached:\d+/u.test(reply),
      `the proxy let the declared host ${ALLOWED_HOST} through (${reply})`,
    );
    check(
      reply.includes('refused=denied:host_not_allowed'),
      `the proxy refused example.com, which the tool never declared (${reply})`,
    );
    // TS3: the tool sandbox's bearer never reaches the agent's runtime container.
    const bearer = await toolSandboxRunToken(gatewaySecret, runId);
    const agentContainers = dockerOutput([
      'ps',
      '--quiet',
      '--filter',
      'label=agent-workspace.runtime',
      '--filter',
      `ancestor=${IMAGES[0][2]}`,
    ])
      .split('\n')
      .filter(Boolean);
    check(agentContainers.length > 0, 'the agent runtime container is still running');
    for (const id of agentContainers) {
      check(
        !dockerOutput(['inspect', id]).includes(bearer),
        `the tool sandbox bearer is not in docker inspect of the agent runtime ${id}`,
      );
      // grep exits 1 when nothing matches, 0 when a file holds the bearer, 2 on an error.
      const grep = spawnSync(
        'docker',
        ['exec', id, 'grep', '-rlsF', '--', bearer, '/workspace', '/tmp'],
        { encoding: 'utf8' },
      );
      check(
        grep.status === 1,
        `the tool sandbox bearer is in no file of the agent runtime ${id} (grep ${String(grep.status)}: ${grep.stdout.trim()})`,
      );
    }
    const seen = /** @type {{ toolRequests: { toolNames: string[] }[] }} */ (
      await (await fetch(`http://127.0.0.1:${String(controlPort)}/requests`)).json()
    );
    // An MCP connector whose name is a usable slug is keyed by it (connectorServerKey, #1109).
    check(
      seen.toolRequests.some((request) =>
        request.toolNames.includes(`mcp__aw-dev-tools__${TOOL_NAME}`),
      ),
      `the model was offered the code tool through the aw-dev-tools server (${JSON.stringify(seen.toolRequests.map((request) => request.toolNames))})`,
    );

    // Acceptance 2: promote succeeds with no hand-seeded connector.
    aw(['promote', 'assistant', '1', '--yes']);
    const promoted = JSON.parse(aw(['versions', '--json']));
    check(
      promoted.pointers.some(
        (/** @type {{ environment: string, number: number }} */ p) =>
          p.environment === 'production' && p.number === 1,
      ),
      'aw promote moved production to the code-tool version',
    );
    failed = false;
  } finally {
    if (failed) {
      spawnSync(
        'docker',
        ['compose', '--project-name', PROJECT, 'logs', '--no-color', '--tail', '200'],
        { cwd: ROOT, stdio: 'inherit' },
      );
      // The egress proxies run outside compose; their denial lines show whether a probe reached one.
      const proxies = spawnSync(
        'docker',
        ['ps', '--all', '--quiet', '--filter', `ancestor=${IMAGES[1][2]}`],
        { encoding: 'utf8' },
      )
        .stdout.split('\n')
        .filter(Boolean);
      for (const id of proxies) {
        console.error(`--- egress proxy ${id} ---`);
        spawnSync('docker', ['logs', '--tail', '200', id], { stdio: 'inherit' });
      }
    }
    spawnSync(
      'docker',
      [
        'compose',
        '--project-name',
        PROJECT,
        'down',
        '--volumes',
        '--remove-orphans',
        '--timeout',
        '5',
      ],
      { cwd: ROOT, stdio: 'inherit' },
    );
    // ponytail: removes every runtime and tool-host container on the daemon, not only this
    // project's; the E2E is documented to need a disposable daemon.
    const leftovers = spawnSync(
      'docker',
      ['ps', '--all', '--quiet', '--filter', 'label=agent-workspace.runtime'],
      { encoding: 'utf8' },
    )
      .stdout.split('\n')
      .filter(Boolean);
    if (leftovers.length > 0)
      spawnSync('docker', ['rm', '--force', '--volumes', ...leftovers], { stdio: 'inherit' });
  }
}

// Imported by tests/e2e/build-deploy-journey for the tool, its probe and the fake provider.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
