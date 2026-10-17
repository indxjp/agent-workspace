#!/usr/bin/env node
/**
 * The kind-deploy proof of #854: `aw deploy production --yes` installs the Helm chart into a kind
 * cluster whose CNI enforces NetworkPolicy, one agent turn completes, and the session ran in a Pod
 * the runner manager created through the kubernetes driver. The isolation cases then run against
 * Pods the same manager allocates (`ISOLATION_LANE=kind-chart`, see isolation.yml).
 *
 * It builds the four platform images from this checkout (the generated-project E2E's builder),
 * pushes them to the registry the workflow started on `KD_REGISTRY` (reachable from the host and,
 * through the nodes' containerd `hosts.toml`, from the cluster under the same name), and installs
 * with digest references only. The model provider is the generated-project E2E's fake Anthropic API,
 * run as a Pod in the cluster: CoreDNS answers `api.anthropic.com` with its Service, and the web and
 * gateway images are rebuilt on top to trust its throwaway CA.
 *
 * The cluster is thrown away with the job; nothing is cleaned up, so a failed run leaves its state
 * for the workflow's "Cluster state on failure" step.
 *
 * Environment: `KD_REGISTRY` (default `localhost:5001`), `KD_WORK_DIR` (default a new temporary
 * directory), `KD_REVISION` (default `git rev-parse HEAD`), `KD_BUDGET_MS` (the cap on the image
 * builds, default 40 minutes).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { sessionLabelValue } from '../../../packages/runtime/dist/index.js';
import { buildPinnedImages } from '../../../tests/generated-project/images.mjs';
import { writeFakeProviderFixture } from '../../../tests/generated-project/project.mjs';
import { StackClient, assistantText, terminalStatus } from '../../../tests/generated-project/stack-api.mjs';
import { run } from './lane.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const here = path.join(root, 'infra/tests/isolation');
const registry = process.env.KD_REGISTRY ?? 'localhost:5001';
const work = process.env.KD_WORK_DIR ?? mkdtempSync(path.join(tmpdir(), 'kind-deploy-'));
const budgetMs = Number(process.env.KD_BUDGET_MS ?? 40 * 60_000);
const namespace = 'agent-workspace';
const fakeNamespace = 'aw-fake';
const databaseNamespace = 'aw-db';
const webPort = Number(process.env.KD_WEB_PORT ?? 13000);
const providerPort = 8443;
const project = 'kind-deploy';
const adminEmail = 'admin@kind-deploy.test';
const adminPassword = randomBytes(12).toString('hex');
const providerKey = `sk-ant-e2e-fake-${randomBytes(6).toString('hex')}`;
const managerToken = randomBytes(32).toString('hex');
const databasePassword = randomBytes(16).toString('hex');
const helmDeadlineMs = 12 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stdout.write(`kind-deploy: ${message}\n`);

async function ok(command, args, options) {
  const result = await run(command, args, { timeoutMs: 10 * 60_000, ...options });
  if (result.code !== 0) {
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed (${String(result.code)}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

const kubectl = (...args) => ok('kubectl', args);
const apply = (manifest) => ok('kubectl', ['apply', '-f', '-'], { input: JSON.stringify(manifest) });
const meta = (name, ns, labels) => ({ name, ...(ns === undefined ? {} : { namespace: ns }), ...(labels === undefined ? {} : { labels }) });
const namespaceOf = (name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } });
const secret = (name, ns, stringData) => ({ apiVersion: 'v1', kind: 'Secret', metadata: meta(name, ns), stringData });

/** The digest the registry holds for `repository:tag`, so the chart can be given `name@sha256:…`. */
async function digestOf(repository, tag) {
  const response = await fetch(`http://${registry}/v2/${repository}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
    },
  });
  const digest = response.headers.get('docker-content-digest');
  if (!response.ok || digest === null) throw new Error(`the registry has no ${repository}:${tag} (${String(response.status)})`);
  return `${registry}/${repository}@${digest}`;
}

const repositoryOf = (reference) => reference.slice(registry.length + 1).split(':')[0];

/** Build `file` on top of `base` (a tag in the registry), push it as `<name>:e2e` and return it by digest. */
async function derive(name, file, args, context) {
  const tag = `${registry}/agent-workspace/${name}:e2e`;
  await ok('docker', ['build', '--file', file, '--tag', tag, ...args.flatMap((arg) => ['--build-arg', arg]), context]);
  await ok('docker', ['push', tag]);
  return digestOf(`agent-workspace/${name}`, 'e2e');
}

async function buildImages(fixture) {
  const deadline = Date.now() + budgetMs;
  const revision = process.env.KD_REVISION ?? (await ok('git', ['rev-parse', 'HEAD']));
  log('building the platform images');
  const tags = buildPinnedImages({ registry, revision, deadline });
  const digests = {};
  for (const [variable, tag] of Object.entries(tags)) digests[variable] = await digestOf(repositoryOf(tag), tag.split(':').pop());
  log('deriving the trusted web and gateway images and the isolation runtime image');
  const context = path.join(work, 'derive');
  mkdirSync(context, { recursive: true });
  copyFileSync(path.join(fixture, 'ca.pem'), path.join(context, 'ca.pem'));
  const trusted = (name, base) => derive(`${name}-trusted`, path.join(here, 'trust-ca.Dockerfile'), [`BASE_IMAGE=${base}`], context);
  const images = {
    web: await trusted('web', digests.AW_WEB_IMAGE),
    gateway: await trusted('gateway', digests.AW_GATEWAY_IMAGE),
    runnerManager: digests.AW_RUNNER_IMAGE,
    runtime: await derive('runtime-probe', path.join(here, 'runtime-probe.Dockerfile'), [`RUNTIME_IMAGE=${digests.AW_RUNTIME_IMAGE}`], context),
    fakeBase: digests.AW_WEB_IMAGE,
  };
  const proxyTag = `${registry}/agent-workspace/egress-proxy:e2e`;
  await ok('docker', ['build', '--file', 'egress-proxy.Dockerfile', '--target', 'egress-proxy', '--tag', proxyTag, '.'], { timeoutMs: 20 * 60_000 });
  await ok('docker', ['push', proxyTag]);
  images.egressProxy = await digestOf('agent-workspace/egress-proxy', 'e2e');
  return images;
}

/** The fake Anthropic API as a Pod; the web image carries the Node it needs. */
async function startFakeProvider(fixture, image) {
  await apply(namespaceOf(fakeNamespace));
  const read = (file) => readFileSync(path.join(fixture, file), 'utf8');
  await apply({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: meta('fake-anthropic-script', fakeNamespace),
    data: { 'fake-anthropic.mjs': read('fake-anthropic.mjs') },
  });
  await apply(
    secret('fake-anthropic-tls', fakeNamespace, {
      'api.anthropic.com.pem': read('api.anthropic.com.pem'),
      'api.anthropic.com.key': read('api.anthropic.com.key'),
    }),
  );
  await apply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: meta('fake-anthropic', fakeNamespace, { app: 'fake-anthropic' }),
    spec: {
      containers: [
        {
          name: 'fake',
          image,
          command: ['node', '/fake/script/fake-anthropic.mjs'],
          env: [
            { name: 'FAKE_ANTHROPIC_PORT', value: String(providerPort) },
            { name: 'FAKE_ANTHROPIC_TLS_CERT', value: '/fake/tls/api.anthropic.com.pem' },
            { name: 'FAKE_ANTHROPIC_TLS_KEY', value: '/fake/tls/api.anthropic.com.key' },
          ],
          ports: [{ containerPort: providerPort }, { containerPort: 8081 }],
          readinessProbe: { httpGet: { path: '/healthz', port: 8081 }, periodSeconds: 2 },
          volumeMounts: [
            // A subPath mount is the file itself: a ConfigMap volume serves it through `..data` symlinks, which
            // Node resolves for `import.meta.url`, so the script's run-as-main guard would never fire.
            { name: 'script', mountPath: '/fake/script/fake-anthropic.mjs', subPath: 'fake-anthropic.mjs' },
            { name: 'tls', mountPath: '/fake/tls' },
          ],
        },
      ],
      volumes: [
        { name: 'script', configMap: { name: 'fake-anthropic-script' } },
        { name: 'tls', secret: { secretName: 'fake-anthropic-tls' } },
      ],
    },
  });
  await apply({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta('fake-anthropic', fakeNamespace),
    spec: {
      selector: { app: 'fake-anthropic' },
      ports: [
        { name: 'https', port: 443, targetPort: providerPort },
        { name: 'control', port: 8081, targetPort: 8081 },
      ],
    },
  });
  await kubectl('wait', '--for=condition=Ready', 'pod/fake-anthropic', '-n', fakeNamespace, '--timeout=180s');
}

/** CoreDNS answers `api.anthropic.com` with the fake's Service, so the pods dial it by its real name. */
async function rewriteProviderDns() {
  const configMap = JSON.parse(await kubectl('get', 'configmap', 'coredns', '-n', 'kube-system', '-o', 'json'));
  const rewrite = `rewrite name exact api.anthropic.com fake-anthropic.${fakeNamespace}.svc.cluster.local`;
  if (!configMap.data.Corefile.includes(rewrite)) {
    configMap.data.Corefile = configMap.data.Corefile.replace('.:53 {', `.:53 {\n    ${rewrite}`);
    await apply(configMap);
    await kubectl('rollout', 'restart', 'deployment/coredns', '-n', 'kube-system');
    await kubectl('rollout', 'status', 'deployment/coredns', '-n', 'kube-system', '--timeout=180s');
  }
}

async function startDatabase() {
  await apply(namespaceOf(databaseNamespace));
  await apply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: meta('postgres', databaseNamespace, { app: 'postgres' }),
    spec: {
      containers: [
        {
          name: 'postgres',
          image: 'postgres:17-alpine',
          env: [
            { name: 'POSTGRES_USER', value: 'aw' },
            { name: 'POSTGRES_DB', value: 'aw' },
            { name: 'POSTGRES_PASSWORD', value: databasePassword },
          ],
          ports: [{ containerPort: 5432 }],
          readinessProbe: { exec: { command: ['pg_isready', '-U', 'aw', '-d', 'aw'] }, periodSeconds: 2 },
        },
      ],
    },
  });
  await apply({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta('postgres', databaseNamespace),
    spec: { selector: { app: 'postgres' }, ports: [{ port: 5432, targetPort: 5432 }] },
  });
  await kubectl('wait', '--for=condition=Ready', 'pod/postgres', '-n', databaseNamespace, '--timeout=180s');
}

/** The namespace and the three Secrets the chart reads and `aw deploy` leaves to the operator. */
async function createSecrets() {
  await apply(namespaceOf(namespace));
  await apply(secret('agent-workspace-database', namespace, { DATABASE_URL: `postgres://aw:${databasePassword}@postgres.${databaseNamespace}.svc.cluster.local:5432/aw` }));
  await apply(secret('agent-workspace-object-store', namespace, {}));
  await apply(
    secret('agent-workspace-secrets', namespace, {
      MASTER_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      GATEWAY_TOKEN_SECRET: randomBytes(32).toString('hex'),
      SESSION_SECRET: randomBytes(32).toString('hex'),
      BOOTSTRAP_ADMIN: adminEmail,
      BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      AW_INSTANCE_ID: project,
      AW_TRUSTED_PROXY_HOPS: '0',
      GATEWAY_PRICING_JSON: JSON.stringify({ version: 'unconfigured', models: { 'disabled:unconfigured': { inputUsdPerMillion: '0', outputUsdPerMillion: '0' } } }),
      MODEL_GATEWAY_URL: 'http://agent-workspace-gateway:4000',
      RUNNER_MANAGER_URL: 'http://agent-workspace-runner-manager:8080',
      RUNNER_MANAGER_TOKEN: managerToken,
    }),
  );
}

function writeInstallFiles(images, apiServer) {
  const home = path.join(work, 'home');
  const projectDirectory = path.join(work, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(projectDirectory, { recursive: true });
  writeFileSync(
    path.join(projectDirectory, 'agent-workspace.yaml'),
    [
      'apiVersion: agentworkspace.dev/v2',
      'kind: Project',
      `name: ${project}`,
      'environments:',
      '  local:',
      '    cloud: local',
      '    identity:',
      `      bootstrapAdmin: ${adminEmail}`,
      '  production:',
      '    target: kubernetes',
      '    url: https://agents.kind-deploy.test',
      '',
    ].join('\n'),
  );
  const values = path.join(work, 'values.json');
  writeFileSync(
    values,
    JSON.stringify({
      replicas: { web: 1, gateway: 1 },
      database: { podSelector: { app: 'postgres' }, namespace: databaseNamespace },
      // The fake provider is a Pod, so the egress rule names it; a Service port is DNATed before the policy sees it.
      providers: { port: providerPort, cidr: '', except: [], podSelector: { app: 'fake-anthropic' }, namespace: fakeNamespace },
      runtime: { driver: 'kubernetes', egressProxyImage: images.egressProxy },
      // Production narrows the runner manager's API egress to the API server; so does the lane.
      kubernetesApi: { cidr: `${apiServer}/32` },
    }),
  );
  return { home, projectDirectory, values };
}

async function deploy(images, { home, projectDirectory, values }) {
  log('aw deploy production --yes');
  const result = await run('node', [path.join(root, 'packages/aw/dist/index.js'), 'deploy', 'production', '--yes', '--infra', path.join(root, 'infra')], {
    timeoutMs: helmDeadlineMs,
    cwd: projectDirectory,
    env: {
      ...process.env,
      HOME: home,
      // The throwaway HOME has no ~/.kube/config, so helm is pointed at the kind cluster's explicitly.
      KUBECONFIG: process.env.KUBECONFIG ?? path.join(homedir(), '.kube', 'config'),
      AW_HELM_VALUES: values,
      AW_WEB_IMAGE: images.web,
      AW_GATEWAY_IMAGE: images.gateway,
      AW_RUNNER_IMAGE: images.runnerManager,
      AW_RUNTIME_IMAGE: images.runtime,
    },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.code, 0, `aw deploy failed (${String(result.code)})`);
  assert.match(result.stdout, /deployed production/u);
}

async function portForward() {
  const child = spawn('kubectl', ['port-forward', '-n', namespace, 'service/agent-workspace-web', `${String(webPort)}:3000`], { stdio: 'inherit' });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const reachable = await fetch(`http://127.0.0.1:${String(webPort)}/`, { redirect: 'manual', signal: AbortSignal.timeout(2_000) }).then(() => true, () => false);
    if (reachable) return child;
    await sleep(1_000);
  }
  child.kill();
  throw new Error('the web service is not reachable through kubectl port-forward');
}

/** Every sandbox Pod seen while `body` runs, with what the assertion needs of it. */
async function watchSandboxes(body) {
  const seen = new Map();
  let watching = true;
  const poll = (async () => {
    while (watching) {
      const result = await run('kubectl', ['get', 'pods', '-n', namespace, '-l', 'app.kubernetes.io/name=agent-runtime', '--show-managed-fields', '-o', 'json']);
      if (result.code === 0) {
        for (const pod of JSON.parse(result.stdout).items) {
          seen.set(pod.metadata.name, {
            session: pod.metadata.labels?.['agent-workspace/session'],
            managers: (pod.metadata.managedFields ?? []).map((field) => field.manager),
            serviceAccount: pod.spec.serviceAccountName,
            images: pod.spec.containers.map((container) => container.image),
          });
        }
      }
      await sleep(500);
    }
  })();
  try {
    return { result: await body(), seen };
  } finally {
    watching = false;
    await poll;
  }
}

async function agentTurn(images) {
  const forward = await portForward();
  try {
    const client = new StackClient(`http://127.0.0.1:${String(webPort)}`);
    log('setup with runtime kubernetes (start, echo and destroy through the runner manager)');
    const setup = await client.setup({
      provider: 'anthropic',
      providerApiKey: providerKey,
      runtime: 'kubernetes',
      adminEmail,
      adminPassword,
      agentName: 'kind-deploy agent',
      agentInstructions: 'Answer briefly.',
    });
    assert.equal(setup.status, 201, setup.text);
    const { agentId } = setup.json;

    const marker = `e2e-nonce-kind${randomBytes(4).toString('hex')}`;
    const reply = `Fake Anthropic reply to ${marker}: the generated project answered.`;
    log('one agent turn');
    const { result, seen } = await watchSandboxes(async () => {
      const started = await client.request(`/api/agents/${agentId}/runs`, { method: 'POST', body: { prompt: `Reply with the marker ${marker}.` } });
      assert.equal(started.status, 202, started.text);
      const runId = started.json.run.id;
      const frames = await client.runFrames(runId);
      return { runId, frames };
    });
    assert.equal(terminalStatus(result.frames), 'completed', JSON.stringify(result.frames.slice(-5)));
    assert.ok(assistantText(result.frames).includes(reply), 'the fake provider\'s reply is missing from the run');

    const stored = await client.request(`/api/runs/${result.runId}`);
    assert.equal(stored.json.run.status, 'completed');
    const label = sessionLabelValue(stored.json.run.sessionId);
    const sandbox = [...seen.entries()].find(([, pod]) => pod.session === label);
    assert.ok(sandbox !== undefined, `no Pod labelled for session ${label} was seen; saw ${JSON.stringify([...seen])}`);
    const [name, pod] = sandbox;
    assert.ok(pod.managers.includes('agent-workspace-runner-manager'), `${name} was not created by the runner manager: ${pod.managers.join(',')}`);
    assert.equal(pod.serviceAccount, 'agent-runtime');
    assert.ok(pod.images.includes(images.runtime), `${name} does not run the engine image: ${pod.images.join(',')}`);

    const asked = JSON.parse(await kubectl('get', '--raw', `/api/v1/namespaces/${fakeNamespace}/services/fake-anthropic:control/proxy/requests`)).requests;
    assert.ok(asked.some((request) => request.reply === reply && request.apiKey === providerKey), 'the fake provider never answered this turn through the gateway');
    log(`the session ran in Pod ${name}, created by the kubernetes driver; the run completed`);
  } finally {
    forward.kill();
  }
}

const fixtureRoot = path.join(work, '.e2e');
writeFakeProviderFixture(work, path.join(root, 'tests/generated-project/fake-anthropic.mjs'));
const images = await buildImages(fixtureRoot);
await startDatabase();
await startFakeProvider(fixtureRoot, images.fakeBase);
await rewriteProviderDns();
await createSecrets();
const apiServer = await kubectl('get', 'endpoints', 'kubernetes', '-n', 'default', '-o', 'jsonpath={.subsets[0].addresses[0].ip}');
if (apiServer === '') throw new Error('the kubernetes Service has no endpoint address');
await deploy(images, writeInstallFiles(images, apiServer));
await agentTurn(images);
log('done');
