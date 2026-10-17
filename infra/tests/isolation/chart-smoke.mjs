/**
 * Chart smoke for the kind lane (#849, #796): install the Helm chart into a cluster whose CNI
 * enforces NetworkPolicy and prove the default-deny policy leaves the migrate Job its way to
 * PostgreSQL and to DNS. Helm runs a pre-install hook before it creates the release's policies, so
 * the install's run of the Job proves nothing about them; a `helm upgrade` then runs the Job again
 * as a pre-upgrade hook with the policies in place, and only returns when it has completed.
 *
 * The cluster is the lane's own and is thrown away with the job, so nothing is cleaned up: a
 * failed run leaves its state for the workflow's "Cluster state on failure" step.
 *
 * The web image comes from `kind load` (`SMOKE_WEB_IMAGE`), so the chart's digest-only image
 * schema is skipped for this one install. Gateway, runner manager and runtime keep the chart's
 * placeholder images: nothing here waits for them.
 */
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

import { run } from './lane.mjs';

const chart = process.env.SMOKE_CHART ?? 'infra/helm/agent-workspace';
const webImage = process.env.SMOKE_WEB_IMAGE ?? 'aw-web:ci';
const probeImage = process.env.ISOLATION_IMAGE ?? 'aw-isolation-probe:ci';
const namespace = 'agent-workspace';
const databaseNamespace = 'aw-smoke-db';
const databaseHost = `postgres.${databaseNamespace}.svc.cluster.local`;
// A throwaway database that lives for this job; the password is random and written nowhere.
// `run` kills a child after 120 s, which cut `helm install` (a hook Job runs inside it) short with an
// empty stderr; helm's own `--timeout 5m` is the deadline, this one only backstops it.
const helmDeadlineMs = 6 * 60_000;
const password = randomBytes(16).toString('hex');

async function ok(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed (${String(result.code)}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

const apply = (manifest) => ok('kubectl', ['apply', '-f', '-'], { input: JSON.stringify(manifest) });
const kubectl = (...args) => ok('kubectl', args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const meta = (name, ns, labels) => ({ name, namespace: ns, ...(labels === undefined ? {} : { labels }) });
const secret = (name, stringData) => ({ apiVersion: 'v1', kind: 'Secret', metadata: meta(name, namespace), stringData });
const namespaceOf = (name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } });

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
            { name: 'POSTGRES_PASSWORD', value: password },
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

/** The isolation checks that ran before this script delete `agent-workspace` without waiting. */
async function freshNamespace() {
  await run('kubectl', ['wait', '--for=delete', `namespace/${namespace}`, '--timeout=180s']);
  await apply(namespaceOf(namespace));
  await apply(secret('agent-workspace-database', { DATABASE_URL: `postgres://aw:${password}@${databaseHost}:5432/aw` }));
  await apply(secret('agent-workspace-object-store', {}));
  await apply(secret('agent-workspace-secrets', {}));
}

/** A pod carrying one of the chart's pod labels, to dial the database from under the release's policies. */
async function probePod(name, component) {
  await apply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: meta(name, namespace, { 'app.kubernetes.io/name': `agent-workspace-${component}` }),
    spec: { containers: [{ name: 'probe', image: probeImage }] },
  });
  await kubectl('wait', '--for=condition=Ready', `pod/${name}`, '-n', namespace, '--timeout=120s');
}

const dial = (pod) => run('kubectl', ['exec', '-n', namespace, pod, '--', 'sh', '-c', `nc -w 5 ${databaseHost} 5432 </dev/null`]);

await startDatabase();
await freshNamespace();

await ok('helm', [
  'install',
  'agent-workspace',
  chart,
  '--namespace',
  namespace,
  '--skip-schema-validation',
  '--set-string',
  `images.web=${webImage}`,
  '--set-string',
  'database.podSelector.app=postgres',
  '--set-string',
  `database.namespace=${databaseNamespace}`,
  '--timeout',
  '5m',
], { timeoutMs: helmDeadlineMs });
// pre-upgrade: the release's policies exist now, so this run of the migrate Job is under them.
await ok('helm', [
  'upgrade',
  'agent-workspace',
  chart,
  '--namespace',
  namespace,
  '--skip-schema-validation',
  '--set-string',
  `images.web=${webImage}`,
  '--set-string',
  'database.podSelector.app=postgres',
  '--set-string',
  `database.namespace=${databaseNamespace}`,
  '--timeout',
  '5m',
], { timeoutMs: helmDeadlineMs });

const applied = await kubectl('exec', '-n', databaseNamespace, 'postgres', '--', 'psql', '-U', 'aw', '-d', 'aw', '-tAc', 'select count(*) from drizzle.__drizzle_migrations');
assert.ok(Number(applied) > 0, `the migrate Job applied no migration (ledger holds ${applied})`);

await probePod('probe-web', 'web');
await probePod('probe-migrate', 'migrate');
await probePod('probe-gateway', 'gateway');
await probePod('probe-other', 'other');
// The CNI programs a pod's policy shortly after it is Ready.
await sleep(5_000);
for (const pod of ['probe-web', 'probe-migrate', 'probe-gateway']) {
  const allowed = await dial(pod);
  assert.equal(allowed.code, 0, `${pod} cannot reach the database: ${allowed.stderr.trim()}`);
}
// The negative control: a pod the allowances do not name is under the same default deny, so a
// refusal here shows the policies are enforced and the successes above are theirs.
const denied = await dial('probe-other');
assert.notEqual(denied.code, 0, 'an unlisted pod reached the database: the policies are not enforced');
console.log('chart smoke: migrations applied under default-deny; web, migrate and gateway reach the database, an unlisted pod does not');
