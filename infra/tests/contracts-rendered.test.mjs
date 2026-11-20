import assert from 'node:assert/strict';
import test from 'node:test';

import { declaredVariables, golden, networkPolicy, read } from './contracts.test-support.mjs';

test('Azure preview keeps control-plane scale-to-zero and sandboxes separately isolated', async () => {
  const apps = await read('infra/terraform/azure-container-apps/apps.tf');
  const sessions = await read('infra/terraform/azure-container-apps/sessions.tf');
  const secrets = await read('infra/terraform/azure-container-apps/identities-secrets.tf');
  const storage = await read('infra/terraform/azure-container-apps/storage-database.tf');
  const variables = await read('infra/terraform/azure-container-apps/variables.tf');
  const workflow = await read('.github/workflows/azure-preview.yml');

  assert.equal((apps.match(/min_replicas\s*=\s*0/gu) ?? []).length, 3);
  assert.match(apps, /resource "azurerm_container_app" "web"[\s\S]*external_enabled\s*=\s*true/u);
  assert.match(
    apps,
    /resource "azurerm_container_app" "runner"[\s\S]*external_enabled\s*=\s*false[\s\S]*max_replicas\s*=\s*1/u,
  );
  assert.match(sessions, /type\s*=\s*"Microsoft\.App\/sessionPools@/u);
  assert.match(sessions, /readySessionInstances\s*=\s*var\.session_pool_ready_instances/u);
  assert.match(sessions, /managedIdentitySettings[\s\S]*lifecycle\s*=\s*"None"/u);
  assert.match(sessions, /role_definition_name\s*=\s*"Azure ContainerApps Session Executor"/u);
  assert.match(sessions, /AW_SESSION_MIRROR_URL/u);
  assert.match(apps, /key_vault_secret_id/u);
  assert.match(secrets, /role_definition_name\s*=\s*"Key Vault Secrets User"/u);
  assert.match(storage, /public_network_access_enabled\s*=\s*false/u);
  assert.match(apps, /name\s*=\s*"AW_STORAGE_URL"[\s\S]{0,200}value\s*=\s*"azblob:\/\//u);
  // A sovereign cloud's blob host is not *.blob.core.windows.net, so the URL can name it.
  assert.match(
    apps,
    /"AW_STORAGE_URL"[\s\S]{0,300}var\.storage_blob_endpoint == null \? "" : "\?endpoint=\$\{var\.storage_blob_endpoint\}"/u,
  );
  assert.match(variables, /variable "storage_blob_endpoint" \{[\s\S]*?default\s*=\s*null/u);
  assert.match(apps, /name\s*=\s*"AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES"/u);
  // The old storage settings: the server ignores them with a warning, so setting one here
  // would only print that warning on every start.
  assert.doesNotMatch(
    apps,
    /"(OBJECT_STORAGE_BACKEND|OBJECT_STORAGE_BUCKET|OBJECT_STORAGE_ENDPOINT|AW_SESSION_TRANSCRIPT_ROOT)"/u,
  );
  assert.match(workflow, /uses: azure\/login@[0-9a-f]{40} # v3\./u);
  assert.doesNotMatch(workflow, /client-secret:/u);
});

test('GCP Cloud Run passes the project features to web only when set (ADR-0160 D5, #1495)', async () => {
  const terraform = await read('infra/terraform/gcp-cloudrun/main.tf');
  const declarations = declaredVariables(await read('infra/terraform/gcp-cloudrun/variables.tf'));
  const declaration = declarations.get('deployment_features') ?? '';
  const service = terraform.split('resource "google_cloud_run_v2_service" "web" {')[1] ?? '';
  const web = service.split(/\nresource /u)[0] ?? '';

  assert.match(
    web,
    /for_each\s*=\s*var\.deployment_features == "" \? \[\] : \[var\.deployment_features\][\s\S]{0,120}name\s*=\s*"AW_DEPLOYMENT_FEATURES"/u,
  );
  // Set once, on web; the other mention is the module's list of names it reserves on web.
  assert.equal((terraform.match(/name\s*=\s*"AW_DEPLOYMENT_FEATURES"/gu) ?? []).length, 1);
  assert.match(declaration, /type\s*=\s*string/u);
  assert.match(declaration, /default\s*=\s*""/u);
  assert.ok(declaration.includes('can(regex("^([a-z]+(,[a-z]+)*)?$", var.deployment_features))'));
});

const RENDERED_TFVARS = [
  ['gcp', 'gcp-cloudrun', 'deploy-terraform-gcp-cloudrun.auto.tfvars.json'],
  ['azure', 'azure-container-apps', 'deploy-terraform-azure-container-apps.auto.tfvars.json'],
];

test('every rendered Terraform variable is declared by the module it is applied in', async () => {
  for (const [cloud, module, file] of RENDERED_TFVARS) {
    const rendered = JSON.parse(await golden(cloud, file));
    const declarations = declaredVariables(await read(`infra/terraform/${module}/variables.tf`));

    for (const name of Object.keys(rendered)) {
      assert.ok(
        declarations.has(name),
        `${module} declares no variable "${name}", which the ${cloud} profile renders`,
      );
    }
    // The profile is only worth rendering if it supplies something: an empty artefact would
    // pass the check above vacuously.
    assert.ok(Object.keys(rendered).length > 0, `${cloud} renders no Terraform variables`);
  }
});

test('no rendered Terraform variable restates a default the module already provides', async () => {
  for (const [cloud, module, file] of RENDERED_TFVARS) {
    const rendered = JSON.parse(await golden(cloud, file));
    const declarations = declaredVariables(await read(`infra/terraform/${module}/variables.tf`));

    for (const name of Object.keys(rendered)) {
      assert.doesNotMatch(
        declarations.get(name) ?? '',
        /^\s+default\s*=/mu,
        `${module}'s "${name}" already has a default; the ${cloud} profile must not restate it`,
      );
    }
  }
});

/**
 * The clouds whose generated projects carry a chart overlay.
 *
 * `azure` is deliberately absent. Its native `azblob://` provider requires a Blob endpoint and
 * managed-identity wiring supplied by the Container Apps Terraform module, not the chart.
 */
const CHART_CLOUDS = ['aws', 'gcp'];

test('a chart overlay is rendered for exactly the clouds whose store the chart can serve', async () => {
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');
  // The two chart properties that make an s3:// bucket the only store it can serve.
  assert.match(deployments, /readOnlyRootFilesystem: true/u);
  assert.doesNotMatch(deployments, /^ +volumeMounts:$/mu);

  for (const cloud of ['aws', 'gcp', 'azure']) {
    const profile = await golden(cloud, 'agent-workspace.yaml');
    const objectStore = /^  objects: (.*)$/mu.exec(profile)?.[1] ?? '';
    const chartCanServeStore = objectStore.startsWith('s3://') || objectStore.startsWith('gcs://');
    const overlay = await golden(cloud, 'deploy-helm-values.yaml').then(
      () => true,
      () => false,
    );
    assert.equal(
      overlay,
      CHART_CLOUDS.includes(cloud),
      `the ${cloud} project ${overlay ? 'renders' : 'renders no'} chart overlay`,
    );
    assert.equal(
      chartCanServeStore,
      overlay,
      `the ${cloud} project's overlay and its object-store bucket disagree`,
    );
  }
});

/**
 * One `images.*` value of a values document. `images.runtime` is the `engine → image` map since
 * ENG-07 (docs/adr/0073-one-runtime-image-per-engine.md), so its value is the `claude-agent-sdk`
 * entry one level down — the one engine every deployment ships today. Comment lines between the
 * key and the entry are skipped, as `values.yaml` has them.
 */
function imageValue(document, key) {
  if (key === 'runtime') {
    return /^ {2}runtime:\n(?: {2}#.*\n)* {4}claude-agent-sdk: (\S+)$/mu.exec(document)?.[1];
  }
  return new RegExp(`^ {2}${key}: (\\S+)$`, 'mu').exec(document)?.[1];
}

test('every rendered Helm value is one the chart declares, and is a pinned digest', async () => {
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));
  const fields = schema.properties.images.required;
  assert.deepEqual(fields, ['web', 'gateway', 'runnerManager', 'runtime']);

  for (const cloud of CHART_CLOUDS) {
    const overlay = await golden(cloud, 'deploy-helm-values.yaml');
    // The overlay is the two-level mapping the generator writes: `images:` and nothing else.
    const keys = [...overlay.matchAll(/^([a-zA-Z][a-zA-Z0-9]*):/gmu)].map(([, key]) => key);
    assert.deepEqual(keys, ['images'], `${cloud} overlay sets more than the chart's images`);

    for (const field of fields) {
      const value = imageValue(overlay, field);
      assert.ok(value, `${cloud} overlay does not set images.${field}`);
      // `images.runtime` is the `engine → image` map since ENG-07; its schema is a `oneOf` whose
      // first branch is the map, and every entry carries the same digest pattern.
      const property = schema.properties.images.properties[field];
      assert.match(
        value,
        new RegExp(property.pattern ?? property.oneOf[0].additionalProperties.pattern, 'u'),
        `${cloud} overlay's images.${field} is not the immutable digest the chart's schema requires`,
      );
    }
  }
});

/**
 * Issue #1512: `aw deploy`'s kubernetes overlay with `environments.production.apps`, as the CLI's
 * deploy test pins it byte for byte. Every top-level key and every `apps[]` field it writes has to
 * be one the chart's strict schema declares, with a value its pattern takes, or `helm install`
 * refuses the overlay.
 */
test('every rendered Helm value with apps is one the chart declares', async () => {
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));
  const overlay = await read('packages/cli/src/deploy/fixtures/helm-apps-values.yaml');

  const keys = [...overlay.matchAll(/^([a-zA-Z][a-zA-Z0-9]*):/gmu)].map(([, key]) => key);
  assert.deepEqual(keys, ['images', 'ingress', 'publicUrl', 'apps']);
  for (const key of keys) assert.ok(schema.properties[key], `the chart does not declare ${key}`);

  const item = schema.properties.apps.items;
  assert.equal(schema.properties.apps.type, 'array');
  assert.equal(item.additionalProperties, false);
  const block = overlay.split(/^apps:\n/mu)[1] ?? '';
  const apps = block
    .split(/^ {2}- /mu)
    .filter((entry) => entry.trim() !== '')
    .map((entry) =>
      Object.fromEntries(
        [...entry.matchAll(/^(?: {4})?([a-zA-Z]+): (\S+)$/gmu)].map(([, key, value]) => [
          key,
          value,
        ]),
      ),
    );
  assert.deepEqual(
    apps.map(({ name, schema: appSchema }) => [name, appSchema]),
    [
      ['desk', 'app_desk'],
      ['service-desk', 'app_service_desk'],
    ],
  );
  for (const app of apps) {
    for (const required of item.required) assert.ok(app[required], `apps[] lacks ${required}`);
    for (const [field, value] of Object.entries(app)) {
      const property = item.properties[field];
      assert.ok(property, `the chart does not declare apps[].${field}`);
      assert.match(value, new RegExp(property.pattern, 'u'), `apps[].${field} ${value}`);
    }
    // The chart names an app's Service `agent-workspace-app-<name>`, a 63-character DNS label.
    assert.ok(`agent-workspace-app-${app.name}`.length <= 63);
  }
  const name = new RegExp(item.properties.name.pattern, 'u');
  assert.match('a'.repeat(43), name);
  assert.doesNotMatch('a'.repeat(44), name);
  assert.doesNotMatch(
    `registry.example/desk:latest`,
    new RegExp(item.properties.image.pattern, 'u'),
  );
  assert.doesNotMatch('public', new RegExp(item.properties.schema.pattern, 'u'));

  const base = await read('infra/helm/agent-workspace/values.yaml');
  assert.match(base, /^apps: \[\]$/mu);
});

/**
 * The app workloads (issue #1512) read only their own Secret, mount no ServiceAccount token, run
 * under the platform pods' security context, and are reached and reach out only through the
 * policies made for them.
 */
test('each app is a hardened Deployment reading only its own Secret, behind its own policies', async () => {
  const apps = await read('infra/helm/agent-workspace/templates/apps.yaml');
  assert.match(apps, /range \$app := \.Values\.apps/u);
  assert.match(apps, /printf "agent-workspace-app-%s" \$app\.name/u);
  assert.match(apps, /agent-workspace\.io\/role: app/u);
  assert.match(apps, /automountServiceAccountToken: false/u);
  assert.doesNotMatch(apps, /serviceAccountName/u);
  assert.match(apps, /readOnlyRootFilesystem: true/u);
  assert.match(apps, /runAsNonRoot: true/u);
  assert.match(apps, /AW_APP_MIGRATE_ON_START, value: "1"/u);
  assert.equal((apps.match(/secretRef:/gu) ?? []).length, 1);
  assert.match(apps, /- secretRef: \{ name: \{\{ \$name \}\} \}/u);
  assert.doesNotMatch(apps, /external\.|secrets\.applicationSecret/u);
  assert.equal((apps.match(/path: \/api\/health/gu) ?? []).length, 3);

  const policy = await networkPolicy();
  for (const name of ['apps-dns', 'apps-database', 'apps-egress-https', 'apps-from-ingress']) {
    assert.match(
      policy(name),
      /podSelector: \{ matchLabels: \{ agent-workspace\.io\/role: app \} \}/u,
      name,
    );
  }
  assert.match(policy('apps-database'), /include "agent-workspace\.egressTo" \.Values\.database/u);
  assert.match(policy('apps-egress-https'), /port: 443/u);
  assert.match(policy('apps-from-ingress'), /ingress\.controllerNamespace/u);

  const ingress = await read('infra/helm/agent-workspace/templates/ingress.yaml');
  assert.match(ingress, /range \.Values\.apps/u);
  assert.match(ingress, /printf "agent-workspace-app-%s" \.name/u);
});

test('the chart image pattern takes a registry with a port and still refuses a tag', async () => {
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));
  const digest = `@sha256:${'a'.repeat(64)}`;
  const patterns = [
    schema.properties.images.properties.web.pattern,
    schema.properties.images.properties.runtime.oneOf[0].additionalProperties.pattern,
    schema.properties.runtime.properties.egressProxyImage.pattern,
  ].map((pattern) => new RegExp(pattern, 'u'));
  for (const pattern of patterns) {
    assert.match(`localhost:5001/agent-workspace/web${digest}`, pattern);
    assert.match(`ghcr.io/indxdev/agent-workspace/web${digest}`, pattern);
    assert.doesNotMatch('ghcr.io/indxdev/web:latest', pattern);
    assert.doesNotMatch(`localhost:5001/agent-workspace/web:e2e${digest}`, pattern);
    assert.doesNotMatch(`web${digest}`, pattern);
  }
});

/**
 * The chart runs one image per component, so a Deployment naming an image value that `values.yaml`
 * does not default — or an overlay that pins only some of them — is an install that starts a
 * placeholder digest, or none at all. The three files are held against each other here because no
 * single one of them can notice the disagreement.
 */
test('every image a Deployment names is defaulted by the chart and pinned by the overlay', async () => {
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');
  const base = await read('infra/helm/agent-workspace/values.yaml');

  const referenced = [
    ...new Set(
      [...deployments.matchAll(/\.Values\.images\.([a-zA-Z][a-zA-Z0-9]*)/gu)].map(([, key]) => key),
    ),
  ].sort();
  assert.deepEqual(referenced, ['gateway', 'runnerManager', 'runtime', 'web']);

  for (const key of referenced) {
    assert.ok(
      imageValue(base, key),
      `values.yaml defaults no images.${key}, which templates/deployments.yaml uses`,
    );
    for (const cloud of CHART_CLOUDS) {
      assert.ok(
        imageValue(await golden(cloud, 'deploy-helm-values.yaml'), key),
        `the ${cloud} overlay leaves images.${key} on the chart's placeholder digest`,
      );
    }
  }
});

/**
 * `envFrom` carries three Secrets an operator writes, and `env` wins over all of them. Stating
 * PORT per container from the same dict the containerPort comes from is therefore what stops a
 * Secret — or an ambient default baked into an image — from moving a listener away from the port
 * the Service routes to and all three probes dial.
 */
test("each container's PORT env is the containerPort it publishes", async () => {
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');

  // One template renders all three Deployments, so asserting that both the port it publishes and
  // the PORT it is given are the same `$ports` lookup proves the equality for every component.
  assert.match(deployments, /containerPort: \{\{ index \$ports \$name \}\}/u);
  assert.match(deployments, /name: PORT, value: \{\{ index \$ports \$name \| quote \}\}/u);
  // AW_COMPONENT selected a process out of one shared image. Nothing implemented it and the
  // per-component images replaced it, so a leftover would be a selector nothing reads.
  assert.doesNotMatch(deployments, /AW_COMPONENT/u);

  for (const cloud of ['aws', 'gcp', 'azure']) {
    // PORT is Compose's published host port. A cluster takes the listener from the chart, so a
    // rendered PORT would be a value nothing reads that a Secret could contradict.
    assert.doesNotMatch(
      await golden(cloud, 'env'),
      /^PORT=/mu,
      `the ${cloud} .env renders PORT, which only the Compose project publishes`,
    );
  }
});
