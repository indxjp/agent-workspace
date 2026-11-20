import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import path from 'node:path';
import process from 'node:process';

import { parseDotEnv } from '../../../generated-project/project.mjs';

import { agentWithTool, spawnChecked } from '../../build-deploy-journey/journey.e2e.mjs';
import { digestReference } from '../../build-deploy-journey/registry.mjs';

import { buildTemplate, builderResources } from '../../../../infra/e2b/build-template.mjs';
import { runtimeBuild } from '../../../../infra/e2b/runtime-template.mjs';
import { toolHostBuild } from '../../../../infra/e2b/tool-host-template.mjs';
import { deployBridge } from '../../../../infra/tests/providers/cloudflare-bridge.mjs';

import { deployFakeProvider } from '.././fake-provider.mjs';
import { missingVariables, withRuntimeDefault } from '.././lanes.mjs';

/** @typedef {ReturnType<typeof import('../journey.e2e.mjs').createJourneyContext>} JourneyContext */
/** @param {JourneyContext} context */
async function assignDeploymentUrls(context) {
  const { lane, names, s, ask, check, CLOUDFLARE } = context;
  if (lane.host === 'vercel') {
    s['controlUrl'] = `https://${names.project}.vercel.app`;
    s['frontendUrl'] = `https://${names.project}-web.vercel.app`;
  } else {
    const account = encodeURIComponent(process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '');
    const subdomain = await ask(`${CLOUDFLARE}/accounts/${account}/workers/subdomain`, {
      token: process.env['CLOUDFLARE_API_TOKEN'] ?? '',
    });
    const name = subdomain.json?.result?.subdomain;
    check(
      typeof name === 'string',
      `the account has a workers.dev subdomain (HTTP ${String(subdomain.status)})`,
    );
    s['workersSubdomain'] = name;
    s['controlUrl'] = `https://${names.project}-control-plane.${name}.workers.dev`;
    s['frontendUrl'] = `https://${names.project}-web.${name}.workers.dev`;
  }
}
/** @param {JourneyContext} context */
async function writeFrontendAndAgent(context) {
  const { s, check, frontendDir, frontendFiles } = context;
  const { project, agentPath, rendered } = s['created'];
  // The frontend, and the allowed origin the hosted surface and the widget answer.
  mkdirSync(frontendDir(), { recursive: true });
  for (const [file, text] of Object.entries(frontendFiles()))
    writeFileSync(path.join(frontendDir(), file), text);
  const surface = path.join(project, 'surfaces/main.ts');
  const before = readFileSync(surface, 'utf8');
  const after = before.replace(
    /^( *)name: 'main',$/mu,
    `$1name: 'main',\n$1allowedOrigins: ['${s['frontendUrl']}'],`,
  );
  check(after !== before, 'the main surface lists the frontend origin');
  writeFileSync(surface, after);
  writeFileSync(agentPath, agentWithTool(rendered, "'anthropic default'"));
}
/** @param {JourneyContext} context */
async function deployProvider(context) {
  const { lane, names, secrets, s, check } = context;
  s['providerKey'] = `sk-ant-journey-fake-${randomBytes(6).toString('hex')}`;
  secrets.push(s['providerKey']);
  if (lane.host === 'vercel') {
    check(
      missingVariables(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], process.env).length === 0,
      `${lane.id} deploys its fake provider Worker with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID`,
    );
    secrets.push(process.env['CLOUDFLARE_API_TOKEN'] ?? '');
  }
  s['providerUrl'] = await deployFakeProvider({
    workerName: names.fakeProvider,
    key: s['providerKey'],
  });
}
/** @param {JourneyContext} context */
async function createDatabaseBranch(context) {
  const { names, secrets, ask, check, NEON } = context;
  // A branch of the Neon project is this run's database; teardown deletes it by name.
  const neon = await ask(
    `${NEON}/projects/${encodeURIComponent(process.env['NEON_PROJECT_ID'] ?? '')}/branches`,
    {
      method: 'POST',
      token: process.env['NEON_API_KEY'] ?? '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        branch: { name: names.neonBranch },
        endpoints: [{ type: 'read_write' }],
      }),
    },
  );
  const databaseUrl = neon.json?.connection_uris?.[0]?.connection_uri;
  check(typeof databaseUrl === 'string', `a Neon branch was created (HTTP ${String(neon.status)})`);
  secrets.push(databaseUrl);

  return databaseUrl;
}
/** @param {JourneyContext} context */
async function deploySandboxBridge(context) {
  const { lane, names, secrets, s, pushRuntimeImage } = context;
  if (lane.sandbox === 'cloudflare-sandbox') {
    const bridge = await deployBridge({
      image: pushRuntimeImage(
        digestReference(s['images'].overrides['AW_RUNTIME_IMAGE'] ?? ''),
        process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '',
      ),
      gatewayHost: `${names.project}-gateway.${s['workersSubdomain']}.workers.dev`,
      secrets,
      workerName: names.bridgeWorker,
    });
    context.removeBridge = bridge.remove;
    secrets.push(bridge.bridgeSecret);
    s['bridgeUrl'] = bridge.bridgeUrl;
    s['bridgeSecret'] = bridge.bridgeSecret;
  }
}
/**
 * @param {JourneyContext} context
 * @param {Record<string,string>} entries
 */
async function configureSandboxImages(context, entries) {
  const {
    lane,
    names,
    secrets,
    s,
    ROOT,
    RUNTIME_TEMPLATE_PREFIX,
    TOOL_HOST_TEMPLATE_PREFIX,
    pushVercelSandboxImage,
  } = context;
  if (lane.sandbox === 'vercel-sandbox') {
    secrets.push(process.env['VERCEL_TOKEN'] ?? '');
    entries['VERCEL_SANDBOX_RUNTIME_IMAGE'] = await pushVercelSandboxImage({
      reference: digestReference(s['images'].overrides['AW_RUNTIME_IMAGE'] ?? ''),
      team: process.env['VERCEL_TEAM_ID'] ?? '',
      token: process.env['VERCEL_TOKEN'] ?? '',
      project: names.project,
    });
  }
  if (lane.sandbox === 'e2b') {
    const apiKey = process.env['E2B_API_KEY'] ?? '';
    const [runtimeTemplate, toolHostTemplate] = await Promise.all([
      // The journey proves the commit under test, so the runtime template is built from this
      // checkout (`runtime.Dockerfile`), not taken from the released image the variable pins.
      // `<template>:<build_id>`: the production E2B manager refuses an OCI digest.
      buildTemplate({
        apiKey,
        name: `${RUNTIME_TEMPLATE_PREFIX}-${lane.key}`,
        ...runtimeBuild(ROOT),
        ...builderResources({}),
      }),
      // The tool host is built from this checkout too: a pinned template of an older build
      // can disagree with this commit's manager on the tool host's `/mcp` and token files.
      buildTemplate({
        apiKey,
        name: `${TOOL_HOST_TEMPLATE_PREFIX}-${lane.key}`,
        ...toolHostBuild(ROOT),
        ...builderResources({}),
      }),
    ]);
    Object.assign(entries, {
      EXTERNAL_PROVIDER: 'e2b',
      E2B_API_KEY: apiKey,
      E2B_RUNTIME_TEMPLATE: runtimeTemplate,
      E2B_TOOL_HOST_TEMPLATE: toolHostTemplate,
    });
    secrets.push(entries['E2B_API_KEY'] ?? '');
  }
}
/**
 * @param {JourneyContext} context
 * @param {Record<string,string>} entries
 */
async function configureStorageEnvironment(context, entries) {
  const {
    lane,
    secrets,
    s,
    ask,
    check,
    CLOUDFLARE,
    JOURNEY_DEPLOYMENT_POLICY,
    laneBucket,
    storageEntries,
  } = context;
  // `aw deploy` writes the project's policy ceiling; the profile path does not, so a hosted
  // deployment would have no promotion bar for the gate chapter to be refused by.
  if (lane.deploy === 'profile') {
    entries['AW_DEPLOYMENT_POLICY'] = `'${JOURNEY_DEPLOYMENT_POLICY}'`;
  }
  // Without an R2 key pair the control plane installs no skills, files or session-state API.
  Object.assign(entries, storageEntries(lane.key, process.env));
  secrets.push(
    entries['OBJECT_STORAGE_ACCESS_KEY_ID'] ?? '',
    entries['OBJECT_STORAGE_SECRET_ACCESS_KEY'] ?? '',
  );
  if (lane.host === 'vercel') {
    // `aw deploy --target vercel` reaches the bucket through R2's S3 endpoint and, unlike
    // `--target cloudflare`, does not create the bucket.
    const account = process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '';
    const bucket = laneBucket(lane.key);
    entries['AWS_REGION'] = 'auto';
    const created = await ask(`${CLOUDFLARE}/accounts/${encodeURIComponent(account)}/r2/buckets`, {
      method: 'POST',
      token: process.env['CLOUDFLARE_API_TOKEN'] ?? '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: bucket }),
    });
    // 409 is a bucket that exists (a lane reuses its bucket across runs).
    check(
      created.status === 200 || created.status === 409,
      `the R2 bucket ${bucket} exists (HTTP ${String(created.status)})`,
    );
  }
  if (s['bridgeUrl'] !== undefined) {
    Object.assign(entries, {
      CLOUDFLARE_SANDBOX_BRIDGE_URL: s['bridgeUrl'],
      CLOUDFLARE_SANDBOX_BRIDGE_SECRET: s['bridgeSecret'],
    });
  }
}
/** @param {JourneyContext} context
 * @param {{env:NodeJS.ProcessEnv,longRun:{env:NodeJS.ProcessEnv,timeout:number},entries:Record<string,string>}} options */
async function deployControlPlane(context, { env, longRun, entries }) {
  const { lane, names, s, work, check, sandboxDriver, setDotEnv } = context;
  const { project } = s['created'];
  const bin = (/** @type {string} */ name) => path.join(project, 'node_modules/.bin', name);
  let stateEnvFile;
  if (lane.deploy === 'aw') {
    spawnChecked(bin('aw'), ['deploy', 'production', '--plan'], { cwd: project, ...longRun }, 3);
    stateEnvFile = path.join(
      s['home'],
      '.config/agent-workspace/deployments',
      names.project,
      'production/.env',
    );
    writeFileSync(stateEnvFile, setDotEnv(readFileSync(stateEnvFile, 'utf8'), entries));
    spawnChecked(bin('aw'), ['deploy', 'production', '--yes'], { cwd: project, ...longRun });
  } else {
    const directory = path.join(work, 'deploy', names.project);
    mkdirSync(path.dirname(directory), { recursive: true });
    spawnChecked(bin('create-agent-workspace'), [directory, '--cloud', lane.host], {
      cwd: work,
      env,
    });
    // Every lane names its own driver: the generated default is E2B for Cloudflare (BH061-029),
    // which the Cloudflare Sandbox lane must not deploy.
    const profile = path.join(directory, 'agent-workspace.yaml');
    const yaml = withRuntimeDefault(readFileSync(profile, 'utf8'), sandboxDriver);
    check(yaml !== null, 'the profile names a default runtime driver');
    if (yaml !== null) writeFileSync(profile, yaml);
    spawnChecked(bin('agent-workspace'), ['render', directory], { cwd: work, env });
    stateEnvFile = path.join(directory, '.env');
    writeFileSync(stateEnvFile, setDotEnv(readFileSync(stateEnvFile, 'utf8'), entries));
    spawnChecked(bin('agent-workspace'), ['deploy', directory, '--target', lane.host, '--yes'], {
      cwd: work,
      ...longRun,
    });
  }

  return stateEnvFile;
}

/** @param {JourneyContext} context */
function deploymentEnv(context) {
  const { lane, names, s, ROOT, frontendDir } = context;
  return {
    ...s['userEnv'],
    ...s['images'].overrides,
    AGENT_WORKSPACE_SOURCE: ROOT,
    AGENT_WORKSPACE_PROJECT_NAME: names.project,
    AGENT_WORKSPACE_FRONTEND: frontendDir(),
    CONTROL_PLANE_URL: s['controlUrl'],
    ...(lane.host === 'cloudflare' ? { CLOUDFLARE_WORKERS_SUBDOMAIN: s['workersSubdomain'] } : {}),
    ...(s['bridgeUrl'] === undefined ? {} : { CLOUDFLARE_SANDBOX_BRIDGE_URL: s['bridgeUrl'] }),
  };
}

const LONG_RUN_TIMEOUT_MS = 1_800_000;

/** @param {JourneyContext} context */
async function runDeploy(context) {
  const { s, secrets } = context;
  await assignDeploymentUrls(context);
  await writeFrontendAndAgent(context);
  await deployProvider(context);
  const databaseUrl = await createDatabaseBranch(context);
  await deploySandboxBridge(context);
  const env = deploymentEnv(context);
  const longRun = { env, timeout: LONG_RUN_TIMEOUT_MS };
  /** @type {Record<string, string>} */
  const entries = { DATABASE_URL: databaseUrl };
  await configureSandboxImages(context, entries);
  await configureStorageEnvironment(context, entries);
  const stateEnvFile = await deployControlPlane(context, { env, longRun, entries });
  s['stateEnv'] = parseDotEnv(readFileSync(stateEnvFile, 'utf8'));
  secrets.push(s['stateEnv']['BOOTSTRAP_ADMIN_PASSWORD'] ?? '');
}

/** @param {JourneyContext} context */
export function createDeployStep(context) {
  return {
    deploy: () => runDeploy(context),
  };
}
