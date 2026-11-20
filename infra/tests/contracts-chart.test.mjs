import assert from 'node:assert/strict';
import test from 'node:test';

import { golden, read } from './contracts.test-support.mjs';

/** Each AWS_* credential name is read, optionally, from its OBJECT_STORAGE_* Secret key. */
function assertCredentialKeysMapped(deployments) {
  for (const [name, key] of [
    ['AWS_ACCESS_KEY_ID', 'OBJECT_STORAGE_ACCESS_KEY_ID'],
    ['AWS_SECRET_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_ACCESS_KEY'],
  ]) {
    assert.match(
      deployments,
      new RegExp(
        `- name: ${name}\\s+valueFrom:\\s+secretKeyRef:\\s+` +
          `name: \\{\\{ \\$\\.Values\\.external\\.objectStoreSecret \\| quote \\}\\}\\s+` +
          `key: ${key}\\s+optional: true`,
        'u',
      ),
      `templates/deployments.yaml does not set ${name} from the object-store Secret's ${key}`,
    );
  }
  // `optional: true` is load-bearing: an IAM or workload-identity install leaves both keys out of
  // the Secret, and a required key that is absent stops the pod from starting at all.
  assert.equal((deployments.match(/^ +optional: true$/gmu) ?? []).length, 2);
}

/** The storage location and upload limit ride in the Secret; `storage.url` is validated by the schema. */
async function assertStorageUrlWiring(deployments, base) {
  // The location and the upload limit ride in the same Secret through `envFrom`. The location may
  // also be the chart value `storage.url`, rendered only when set: `env` wins over `envFrom`, so a
  // set value replaces the Secret's and an unset one leaves an existing Secret in charge.
  assert.match(
    deployments,
    /envFrom:[\s\S]*?secretRef: \{ name: \{\{ \$\.Values\.external\.objectStoreSecret \| quote \}\} \}/u,
  );
  assert.match(
    deployments,
    /\{\{- with \$\.Values\.storage\.url \}\}\n\s+- \{ name: AW_STORAGE_URL, value: \{\{ \. \| quote \}\} \}\n\s+\{\{- end \}\}/u,
  );
  assert.equal((deployments.match(/AW_STORAGE_URL\s*[,:]/gu) ?? []).length, 1);
  assert.match(base, /^storage:\n {2}url: ''$/mu);
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));
  assert.equal(schema.properties.storage?.additionalProperties, false);
  const url = new RegExp(schema.properties.storage?.properties?.url?.pattern ?? '^$', 'u');
  for (const value of [
    '',
    's3://bucket?region=eu-west-1',
    'gcs://bucket',
    'azblob://acct/c',
    'file:///srv/aw',
  ]) {
    assert.ok(url.test(value), `storage.url refuses ${value}`);
  }
  for (const value of ['bucket', 'http://minio:9000/bucket']) {
    assert.ok(!url.test(value), `storage.url accepts ${value}`);
  }
  assert.doesNotMatch(
    deployments,
    /name: AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES|OBJECT_STORAGE_(BACKEND|BUCKET|ENDPOINT)/u,
  );
  for (const cloud of ['aws', 'gcp']) {
    assert.match(await golden(cloud, 'env'), /^AW_STORAGE_URL=\S+$/mu);
  }
}

/**
 * The rendered `.env` names the object-store credential `OBJECT_STORAGE_ACCESS_KEY_ID` /
 * `OBJECT_STORAGE_SECRET_ACCESS_KEY`, and `apps/web/server/composition/storage.ts` builds its S3
 * client from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. `packages/cli/templates/compose.yaml`
 * translates between the two for the Compose project; on the chart path — the only deploy target
 * `--cloud aws` has — the Deployment is the one place that can, so a missing mapping is a key an
 * operator filled in exactly as the rendered file and `docs/40-operate/deploy/kubernetes.md` instruct and
 * nothing reads, and a files API that answers 503.
 */
test('every control-plane Deployment translates the object-store credential to the AWS_* names', async () => {
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');
  const base = await read('infra/helm/agent-workspace/values.yaml');

  // One template renders all three Deployments from a single container spec, so a mapping stated
  // once is a mapping every control-plane pod carries.
  assert.equal((deployments.match(/kind: Deployment/gu) ?? []).length, 1);
  const ranged = /range \$name, \$replicas := dict ([^}]*)/u.exec(deployments)?.[1] ?? '';
  assert.deepEqual(
    [...ranged.matchAll(/"([a-z-]+)"/gu)].map(([, name]) => name),
    ['web', 'gateway', 'runner-manager'],
  );

  assertCredentialKeysMapped(deployments);
  assert.match(base, /^ {2}objectStoreSecret: \S+$/mu);

  // The generator renders the OBJECT_STORAGE_* half; the mapping above is what makes it readable.
  for (const cloud of ['aws', 'gcp']) {
    assert.match(await golden(cloud, 'env'), /^OBJECT_STORAGE_ACCESS_KEY_ID=/mu);
    assert.match(await golden(cloud, 'env'), /^OBJECT_STORAGE_SECRET_ACCESS_KEY=/mu);
  }

  await assertStorageUrlWiring(deployments, base);
});

test('web and gateway use the annotatable workload-identity ServiceAccount', async () => {
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');
  const serviceAccounts = await read('infra/helm/agent-workspace/templates/serviceaccount.yaml');
  const base = await read('infra/helm/agent-workspace/values.yaml');
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));

  assert.match(
    deployments,
    /if eq \$name "runner-manager"[\s\S]*serviceAccountName: agent-workspace-runner-manager[\s\S]*else[\s\S]*serviceAccountName: \{\{ \$\.Values\.serviceAccount\.name \| quote \}\}/u,
  );
  assert.match(serviceAccounts, /name: \{\{ \.Values\.serviceAccount\.name \| quote \}\}/u);
  assert.match(serviceAccounts, /toYaml \. \| nindent 4/u);
  assert.match(base, /^serviceAccount:\n {2}name: agent-workspace\n {2}annotations: \{\}$/mu);
  assert.ok(schema.required.includes('serviceAccount'));
  assert.deepEqual(schema.properties.serviceAccount.required, ['name', 'annotations']);
});

test('the chart still defaults every value the rendered overlay deliberately omits', async () => {
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));
  const base = await read('infra/helm/agent-workspace/values.yaml');
  // The overlay carries only `images`; every other required section must come from the chart, or
  // an install layered on the generated file would fail schema validation.
  for (const required of schema.required) {
    if (required === 'images') continue;
    assert.match(
      base,
      new RegExp(`^${required}:`, 'mu'),
      `values.yaml no longer defaults "${required}", which the rendered overlay does not supply`,
    );
  }
});

/** Every Service block of `services.yaml`, keyed by name with its port and pod selector. */
function publishedServices(services) {
  return new Map(
    services
      .split(/^---$/mu)
      .filter((block) => block.includes('kind: Service'))
      .map((block) => [
        /^ *name: (agent-workspace-[a-z-]+)$/mu.exec(block)?.[1] ??
          /metadata: \{ name: (agent-workspace-[a-z-]+) \}/u.exec(block)?.[1],
        {
          port: Number(/port: (\d+)/u.exec(block)?.[1]),
          selector: /app\.kubernetes\.io\/name: (agent-workspace-[a-z-]+)/u.exec(block)?.[1],
        },
      ]),
  );
}

/** Each cloud's rendered `.env` addresses the chart's Services on the ports they listen on. */
async function assertRenderedAddresses(ports) {
  for (const cloud of ['aws', 'gcp', 'azure']) {
    const env = await golden(cloud, 'env');
    for (const [variable, component] of [
      ['AW_SESSION_MIRROR_URL', 'web'],
      ['MODEL_GATEWAY_URL', 'gateway'],
      ['RUNNER_MANAGER_URL', 'runner-manager'],
    ]) {
      assert.match(
        env,
        new RegExp(
          `^${variable}=http://agent-workspace-${component}:${ports.get(component)}$`,
          'mu',
        ),
        `the ${cloud} .env does not render ${variable} as the chart's ${component} Service`,
      );
    }
    // The chart deploys no runner: the runner-manager creates each sandbox and returns its
    // address per run, so there is no Service for the renderer to name.
    assert.match(
      env,
      /^RUNNER_URL=$/mu,
      `the ${cloud} .env names a runner address the chart does not publish`,
    );
  }
}

/**
 * The chart's Services and the generator's rendered `.env` are two halves of one contract: every
 * in-cluster address `serviceAddresses` (`packages/cli/src/render/env.ts`) writes has to be a
 * Service this chart publishes, on the port the Deployment listens on. Without this pairing a
 * renamed or missing Service is not a failing test but a control plane that silently cannot reach
 * the component it is configured for.
 */
test('every control-plane address the generator renders is a Service the chart publishes', async () => {
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');
  const services = await read('infra/helm/agent-workspace/templates/services.yaml');

  // `{{- $ports := dict "web" 3000 "gateway" 4000 "runner-manager" 8080 }}` — the one place the
  // chart states which component listens where.
  const ports = new Map(
    [
      ...(/\$ports := dict ([^}]*)/u.exec(deployments)?.[1] ?? '').matchAll(/"([a-z-]+)" (\d+)/gu),
    ].map(([, name, port]) => [name, Number(port)]),
  );
  assert.deepEqual([...ports.keys()], ['web', 'gateway', 'runner-manager']);

  const published = publishedServices(services);

  for (const [component, port] of ports) {
    const name = `agent-workspace-${component}`;
    const service = published.get(name);
    assert.ok(service, `the chart deploys ${component} but publishes no Service named ${name}`);
    assert.equal(service.port, port, `${name} does not publish the port ${component} listens on`);
    // A Service whose selector misses its own Deployment's pod label resolves to no endpoint.
    assert.equal(service.selector, name, `${name} selects pods the ${component} Deployment is not`);
  }

  await assertRenderedAddresses(ports);
});

test('Azure preview federates GitHub OIDC on the environment the deploy job declares', async () => {
  const bootstrap = await read('infra/terraform/azure-container-apps/bootstrap/main.tf');
  const variables = await read('infra/terraform/azure-container-apps/bootstrap/variables.tf');
  const workflow = await read('.github/workflows/azure-preview.yml');

  // A job that declares `environment:` presents a repo:<owner>/<repo>:environment:<name> sub
  // claim, and Entra ID matches the federated subject byte-for-byte. The credential, the
  // variable default, and the workflow must therefore name the same environment.
  assert.match(
    bootstrap,
    /subject\s+=\s+"repo:\$\{var\.github_repository\}:environment:\$\{var\.github_environment\}"/u,
  );
  assert.doesNotMatch(bootstrap, /subject\s+=\s+"[^"]*:ref:/u);

  const environment = /variable "github_environment"[\s\S]*?default\s+=\s+"([^"]+)"/u.exec(
    variables,
  )?.[1];
  assert.equal(environment, 'azure-preview');
  assert.match(workflow, new RegExp(`^ {4}environment: ${environment}$`, 'mu'));
});

/**
 * ADR-0122: the schema is migrated once, before `web` starts. A hook that runs after the new pods
 * start, or one that borrows a ServiceAccount the chart has not created yet, fails an install or
 * upgrade in a way no other file notices.
 */
test('the chart migrates in a pre-install/pre-upgrade Job that reads only the database Secret', async () => {
  const job = await read('infra/helm/agent-workspace/templates/migrate-job.yaml');
  const base = await read('infra/helm/agent-workspace/values.yaml');
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));

  assert.match(job, /^kind: Job$/mu);
  assert.match(job, /helm\.sh\/hook: pre-install,pre-upgrade$/mu);
  assert.match(job, /helm\.sh\/hook-delete-policy: before-hook-creation,hook-succeeded$/mu);
  assert.match(job, /command: \["node", "\/srv\/packages\/core\/dist\/db\/migrate\.js"\]/u);
  assert.match(job, /image: \{\{ \.Values\.images\.web \| quote \}\}/u);
  assert.match(job, /restartPolicy: Never/u);
  assert.match(job, /readOnlyRootFilesystem: true/u);
  assert.match(job, /automountServiceAccountToken: false/u);
  assert.doesNotMatch(job, /serviceAccountName/u);
  assert.match(job, /\{\{- if \.Values\.migrations\.enabled \}\}/u);

  const secrets = [...job.matchAll(/secretRef: \{ name: \{\{ ([^}]+) \}\} \}/gu)].map(
    ([, name]) => name,
  );
  assert.deepEqual(secrets, ['.Values.external.databaseUrlSecret | quote']);

  assert.match(base, /^migrations:\n {2}enabled: true$/mu);
  assert.ok(schema.required.includes('migrations'));
  assert.equal(schema.properties.migrations.additionalProperties, false);
});

test('compose starts web only after the one-shot migrate service has completed', async () => {
  const compose = await read('compose.yaml');
  const service = (name) =>
    compose.split(new RegExp(`^ {2}${name}:\\n`, 'mu'))[1]?.split(/^ {2}[a-z][a-z-]*:\n/mu)[0] ??
    '';

  const migrate = service('migrate');
  assert.match(migrate, /restart: 'no'/u);
  assert.match(migrate, /command: \['node', '\/srv\/packages\/core\/dist\/db\/migrate\.js'\]/u);
  assert.match(migrate, /postgres:\n {8}condition: service_healthy/u);
  // The migrator needs the database and nothing else, so no other secret reaches it.
  assert.deepEqual(
    [...migrate.matchAll(/^ {6}([A-Z_]+):/gmu)].map(([, name]) => name),
    ['DATABASE_URL'],
  );
  // A shared build and tag with `web`, so `up` never tries to pull a tag that exists only locally.
  assert.equal(/image: (\S+)/u.exec(migrate)?.[1], /image: (\S+)/u.exec(service('web'))?.[1]);
  assert.match(migrate, /target: web/u);

  assert.match(service('web'), /migrate:\n {8}condition: service_completed_successfully/u);
});

test('every compose file gives the gateway web as its control-plane origin (#1846)', async () => {
  for (const file of [
    'compose.yaml',
    'infra/terraform/gcp-small/templates/compose.yaml',
    'packages/cli/templates/compose.yaml',
  ]) {
    const compose = await read(file);
    const gateway = compose.split(/^ {2}gateway:\n/mu)[1]?.split(/^ {2}[a-z][a-z-]*:\n/mu)[0] ?? '';
    assert.match(gateway, /^ {6}GATEWAY_CONTROL_PLANE_ORIGIN: http:\/\/web:3000$/mu, file);
  }
});
