import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('release publication selects every executable target explicitly', async () => {
  // The image list lives in infra/release/images.mjs (#370); the script reads it from there.
  const plan = await read('infra/release/images.mjs');
  for (const contract of [
    "web: { dockerfile: 'Dockerfile', target: 'web' }",
    "gateway: { dockerfile: 'gateway.Dockerfile', target: 'gateway' }",
    "runner: { dockerfile: 'Dockerfile', target: 'runner' }",
    "dockerfile: 'runtime.Dockerfile',",
    'engineImages(root)',
  ]) {
    assert.ok(plan.includes(contract), contract);
  }
  const script = await read('infra/release/build-and-push.sh');
  assert.ok(script.includes('node infra/release/images.mjs > "$plan"'));
  assert.ok(script.includes('--target "$target"'));
  assert.doesNotMatch(script, /buildx build[^\n]+-f Dockerfile(?![^\n]+--target)/u);
});

test('GCP Compose publishes only the proxy and scopes component secrets', async () => {
  const compose = await read('infra/terraform/gcp-small/templates/compose.yaml');
  assert.match(compose, /proxy:[\s\S]*?ports:[\s\S]*?- 80:80[\s\S]*?- 443:443/u);
  for (const service of ['web', 'gateway', 'runner', 'postgres']) {
    const section = compose.split(`\n  ${service}:`)[1]?.split(/\n  [a-z][a-z-]*:/u)[0] ?? '';
    assert.doesNotMatch(section, /\n    ports:/u, `${service} must not publish a port`);
  }
  assert.match(compose, /web\.env/u);
  assert.match(compose, /gateway\.env/u);
  assert.match(compose, /runner\.env/u);
  assert.match(compose, /postgres\.env/u);
  assert.match(compose, /AW_STORAGE_URL: file:\/\/\/var\/lib\/agent-workspace\n/u);
  // The old storage settings: the server ignores them with a warning, so setting one here
  // would only print that warning on every start.
  assert.doesNotMatch(
    compose,
    /AW_FILE_STORAGE_ROOT|AW_SKILL_STORAGE_ROOT|AW_SESSION_TRANSCRIPT_ROOT/u,
  );
});

test('Terraform includes rebuild, least privilege, backup, snapshot, and monitoring resources', async () => {
  const terraform = await read('infra/terraform/gcp-small/main.tf');
  for (const resource of [
    'google_compute_instance',
    'google_compute_disk',
    'google_compute_resource_policy',
    'google_secret_manager_secret_iam_member',
    'google_storage_bucket',
    'google_monitoring_uptime_check_config',
    'google_monitoring_slo',
  ]) {
    assert.match(terraform, new RegExp(`resource "${resource}"`, 'u'));
  }
  assert.doesNotMatch(terraform, /0\.0\.0\.0\/0[\s\S]{0,200}ports\s*=\s*\["22"\]/u);
});

test('GCP Cloud Run uses native GCS identity and a CMEK-wrapped Secret Manager master key', async () => {
  const terraform = await read('infra/terraform/gcp-cloudrun/main.tf');
  const variables = await read('infra/terraform/gcp-cloudrun/variables.tf');

  assert.match(terraform, /name\s*=\s*"AW_STORAGE_URL"[\s\S]{0,100}value\s*=\s*"gcs:\/\//u);
  assert.match(terraform, /name\s*=\s*"AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES"/u);
  // The old storage settings: the server ignores them with a warning, so setting one here
  // would only print that warning on every start.
  assert.doesNotMatch(
    terraform,
    /"(OBJECT_STORAGE_BACKEND|OBJECT_STORAGE_BUCKET|AW_FILE_STORAGE_ROOT|AW_SKILL_STORAGE_ROOT|AW_SESSION_TRANSCRIPT_ROOT)"/u,
  );
  assert.match(
    terraform,
    /resource "google_storage_bucket_iam_member" "web_objects"[\s\S]*?google_service_account\.web\.member/u,
  );
  assert.match(
    terraform,
    /resource "google_storage_bucket_iam_member" "web_objects_metadata"[\s\S]*?roles\/storage\.legacyBucketReader[\s\S]*?google_service_account\.web\.member/u,
  );
  assert.doesNotMatch(terraform, /google_storage_hmac_key/u);
  assert.doesNotMatch(terraform, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/u);
  // The project rides in the gcs:// URL's `?project=`, so web gets no GCP_PROJECT; the runner
  // manager's Cloud Run driver still reads it.
  const service = (name) =>
    terraform
      .split(`resource "google_cloud_run_v2_service" "${name}" {`)[1]
      ?.split(/\nresource /u)[0] ?? '';
  assert.match(terraform, /value\s*=\s*"gcs:\/\/[^"]*\?project=\$\{var\.project_id\}"/u);
  assert.doesNotMatch(service('web'), /"GCP_PROJECT"/u);
  assert.match(service('runner_manager'), /name\s*=\s*"GCP_PROJECT"/u);
  assert.doesNotMatch(variables, /objects_hmac_secret/u);

  assert.match(terraform, /resource "google_kms_crypto_key" "secret_manager"/u);
  assert.match(terraform, /rotation_period\s*=\s*"7776000s"/u);
  assert.match(terraform, /roles\/cloudkms\.cryptoKeyEncrypterDecrypter/u);
  assert.match(
    terraform,
    /resource "google_secret_manager_secret" "master_key"[\s\S]*?customer_managed_encryption[\s\S]*?google_kms_crypto_key\.secret_manager\.id/u,
  );
  assert.equal((terraform.match(/name\s*=\s*"MASTER_KEY_PROVIDER"/gu) ?? []).length, 2);
  assert.equal((terraform.match(/name\s*=\s*"GCP_MASTER_KEY_SECRET"/gu) ?? []).length, 2);
  assert.doesNotMatch(terraform, /name\s*=\s*"MASTER_ENCRYPTION_KEY"/u);
  assert.equal(
    (
      terraform.match(
        /secret\s*=\s*google_secret_manager_secret\.deployment\["\$\{var\.name\}-gateway-token-secret"\]\.secret_id/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.doesNotMatch(
    terraform,
    /secret_key_ref\s*\{[\s\S]{0,200}secret\s*=\s*google_secret_manager_secret\.master_key/u,
  );
  assert.doesNotMatch(terraform, /prevent_destroy\s*=\s*true/u);
});

// Project-level IAM resources that give the web service account a Cloud Storage role.
function projectWideWebStorageGrants(terraform) {
  const blocks = terraform.match(/^resource "[^"]+" "[^"]+" \{[\s\S]*?^\}/gmu) ?? [];
  return blocks.filter(
    (block) =>
      /^resource "google_project_iam_(member|binding)"/u.test(block) &&
      /roles\/storage\./u.test(block) &&
      /google_service_account\.web\b/u.test(block),
  );
}

test('[US-STO-10][contract][cli] web storage access is bucket-scoped, never project-wide', async () => {
  const planted = `resource "google_project_iam_member" "web_objects_project" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = google_service_account.web.member
}
`;
  assert.equal(
    projectWideWebStorageGrants(planted).length,
    1,
    'a planted project-level role is rejected',
  );

  for (const file of [
    'infra/terraform/gcp-cloudrun/main.tf',
    'packages/cli/modules/gcp-cloudrun/main.tf',
  ]) {
    const terraform = await read(file);
    assert.deepEqual(
      projectWideWebStorageGrants(terraform),
      [],
      `${file} grants web no project-wide storage role`,
    );
    for (const name of ['web_objects', 'web_state']) {
      assert.match(
        terraform,
        new RegExp(
          String.raw`resource "google_storage_bucket_iam_member" "${name}" \{[^}]*roles/storage\.objectAdmin[^}]*google_service_account\.web\.member`,
          'u',
        ),
        `${file} keeps ${name} bucket-level`,
      );
    }
  }
});

test('Terraform gives the gateway the web origin without a dependency cycle (#1846)', async () => {
  // The gateway section only: from its resource to the next resource.
  const gatewayOf = (terraform, type) =>
    terraform.split(`resource "${type}" "gateway"`)[1]?.split(/^resource /mu)[0] ?? '';
  for (const file of [
    'infra/terraform/gcp-cloudrun/main.tf',
    'packages/cli/modules/gcp-cloudrun/main.tf',
  ]) {
    const gateway = gatewayOf(await read(file), 'google_cloud_run_v2_service');
    assert.match(
      gateway,
      /name\s*=\s*"GATEWAY_CONTROL_PLANE_ORIGIN"\n\s*value\s*=\s*"https:\/\/\$\{var\.name\}-web-\$\{data\.google_project\.current\.number\}\.\$\{var\.region\}\.run\.app"/u,
      file,
    );
    assert.doesNotMatch(gateway, /google_cloud_run_v2_service\.web/u, file);
  }
  const azure = gatewayOf(
    await read('infra/terraform/azure-container-apps/apps.tf'),
    'azurerm_container_app',
  );
  assert.match(
    azure,
    /name\s*=\s*"GATEWAY_CONTROL_PLANE_ORIGIN"\n\s*value\s*=\s*local\.web_base_url/u,
  );
  assert.doesNotMatch(azure, /azurerm_container_app\.web/u);
});

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
  assert.equal((terraform.match(/"AW_DEPLOYMENT_FEATURES"/gu) ?? []).length, 1);
  assert.match(declaration, /type\s*=\s*string/u);
  assert.match(declaration, /default\s*=\s*""/u);
  assert.ok(declaration.includes('can(regex("^([a-z]+(,[a-z]+)*)?$", var.deployment_features))'));
});

/**
 * Split a `variables.tf` into `{ name → declaration }`, so a rendered key can be held against
 * both "is this variable declared" and "does the module already default it".
 */
function declaredVariables(source) {
  const declarations = new Map();
  for (const block of source.split(/\nvariable "/u).slice(1)) {
    const name = block.slice(0, block.indexOf('"'));
    declarations.set(name, block);
  }
  return declarations;
}

/** The generator's committed golden for one cloud's rendered artefact. */
const golden = (cloud, file) => read(`packages/cli/src/fixtures/${cloud}/${file}`);

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

/**
 * The rendered `.env` names the object-store credential `OBJECT_STORAGE_ACCESS_KEY_ID` /
 * `OBJECT_STORAGE_SECRET_ACCESS_KEY`, and `apps/web/server/composition/storage.ts` builds its S3
 * client from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. `packages/cli/templates/compose.yaml`
 * translates between the two for the Compose project; on the chart path — the only deploy target
 * `--cloud aws` has — the Deployment is the one place that can, so a missing mapping is a key an
 * operator filled in exactly as the rendered file and `docs/deploy/kubernetes.md` instruct and
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
  assert.match(base, /^ {2}objectStoreSecret: \S+$/mu);

  // The generator renders the OBJECT_STORAGE_* half; the mapping above is what makes it readable.
  for (const cloud of ['aws', 'gcp']) {
    assert.match(await golden(cloud, 'env'), /^OBJECT_STORAGE_ACCESS_KEY_ID=/mu);
    assert.match(await golden(cloud, 'env'), /^OBJECT_STORAGE_SECRET_ACCESS_KEY=/mu);
  }

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

  const published = new Map(
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

  for (const [component, port] of ports) {
    const name = `agent-workspace-${component}`;
    const service = published.get(name);
    assert.ok(service, `the chart deploys ${component} but publishes no Service named ${name}`);
    assert.equal(service.port, port, `${name} does not publish the port ${component} listens on`);
    // A Service whose selector misses its own Deployment's pod label resolves to no endpoint.
    assert.equal(service.selector, name, `${name} selects pods the ${component} Deployment is not`);
  }

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

/**
 * #849: the chart default-denies every pod, so each connection a component makes needs an egress
 * allowance on the caller and, where the callee is a pod of the release, an ingress allowance on
 * the callee. Without them web, the migrate Job and the runner manager cannot resolve a name or
 * reach PostgreSQL.
 */
const networkPolicy = async () => {
  const policies = await read('infra/helm/agent-workspace/templates/networkpolicy.yaml');
  return (name) =>
    policies.split(/^---$/mu).find((block) => block.includes(`metadata: { name: ${name} }`)) ?? '';
};
const selectedPods = (block) =>
  [...(/values: \[([^\]]+)\]/u.exec(block)?.[1] ?? '').matchAll(/agent-workspace-[a-z-]+/gu)].map(
    ([name]) => name,
  );

test('the chart opens DNS and PostgreSQL egress by pod label under the default deny', async () => {
  const policy = await networkPolicy();
  const base = await read('infra/helm/agent-workspace/values.yaml');
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));

  assert.match(policy('agent-workspace-default-deny'), /ingress: \[\]\n {2}egress: \[\]/u);

  const dns = policy('agent-workspace-dns');
  assert.deepEqual(selectedPods(dns), [
    'agent-workspace-web',
    'agent-workspace-gateway',
    'agent-workspace-runner-manager',
    'agent-workspace-migrate',
  ]);
  assert.match(dns, /kubernetes\.io\/metadata\.name: \{\{ \.Values\.dns\.namespace \| quote \}\}/u);
  assert.match(dns, /matchLabels: \{\{ toJson \.Values\.dns\.podSelector \}\}/u);
  assert.match(dns, /protocol: UDP, port: 53/u);
  assert.match(dns, /protocol: TCP, port: 53/u);
  assert.match(
    base,
    /^dns:\n {2}namespace: kube-system\n {2}podSelector:\n {4}k8s-app: kube-dns$/mu,
  );

  const database = policy('agent-workspace-database');
  assert.deepEqual(selectedPods(database), [
    'agent-workspace-web',
    'agent-workspace-gateway',
    'agent-workspace-runner-manager',
    'agent-workspace-migrate',
  ]);
  assert.match(database, /port: \{\{ \.Values\.database\.port \}\}/u);
  assert.match(database, /include "agent-workspace\.egressTo" \.Values\.database/u);
  // One helper renders every `to:`: a cidr peer, and a podSelector peer that carries the
  // namespaceSelector when the destination is in another namespace.
  const helpers = await read('infra/helm/agent-workspace/templates/_helpers.tpl');
  assert.match(helpers, /"ipBlock" \$block/u);
  assert.match(helpers, /"podSelector" \(dict "matchLabels" \./u);
  assert.match(
    helpers,
    /with \$\.namespace \}\}\n.*set \$peer "namespaceSelector" \(dict "matchLabels" \(dict "kubernetes\.io\/metadata\.name" \.\)\)/u,
  );
  assert.match(
    base,
    /^database:\n {2}port: 5432\n {2}cidr: ''\n {2}podSelector: \{\}\n {2}namespace: ''$/mu,
  );
  assert.deepEqual(schema.properties.database.properties.namespace, { type: 'string' });
  assert.equal(schema.properties.database.additionalProperties, false);
  assert.equal(schema.properties.database.properties.port.maximum, 65535);

  const job = await read('infra/helm/agent-workspace/templates/migrate-job.yaml');
  assert.match(job, /app\.kubernetes\.io\/name: "agent-workspace-migrate"/u);
});

test('the chart pairs every pod-to-pod egress allowance with an ingress allowance', async () => {
  const policy = await networkPolicy();

  const gatewayIn = policy('gateway-from-runner');
  assert.match(gatewayIn, /policyTypes: \[Ingress\]/u);
  assert.match(
    gatewayIn,
    /podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/name: agent-workspace-gateway \} \}/u,
  );
  assert.match(
    gatewayIn,
    /from: \[\{ podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/name: agent-workspace-runner-manager/u,
  );
  assert.match(gatewayIn, /port: 4000/u);
  assert.match(policy('runner-to-gateway'), /port: 4000/u);

  const runnerIn = policy('runner-manager-from-web');
  assert.match(runnerIn, /policyTypes: \[Ingress\]/u);
  assert.match(
    runnerIn,
    /from: \[\{ podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/name: agent-workspace-web/u,
  );
  assert.match(runnerIn, /port: 8080/u);
  const webOut = policy('web-to-runner-manager');
  assert.match(webOut, /policyTypes: \[Egress\]/u);
  assert.match(webOut, /port: 8080/u);

  // #1846: the gateway forwards aw-control calls to web's Service: gateway pods to web pods on
  // TCP 3000, and nothing wider (no namespace, no address block, no sandbox).
  const pod = (name) =>
    `\\{ podSelector: \\{ matchLabels: \\{ app\\.kubernetes\\.io\\/name: ${name} \\} \\} \\}`;
  const only3000 = '\\n {6}ports: \\[\\{ protocol: TCP, port: 3000 \\}\\]\\n$';
  const gatewayOut = policy('gateway-to-web');
  assert.match(gatewayOut, /policyTypes: \[Egress\]/u);
  assert.match(
    gatewayOut,
    /spec:\n {2}podSelector: \{ matchLabels: \{ [^}]+agent-workspace-gateway \} \}/u,
  );
  assert.match(gatewayOut, new RegExp(`- to: \\[${pod('agent-workspace-web')}\\]${only3000}`, 'u'));
  const webIn = policy('web-from-gateway');
  assert.match(webIn, /policyTypes: \[Ingress\]/u);
  assert.match(
    webIn,
    new RegExp(`- from: \\[${pod('agent-workspace-gateway')}\\]${only3000}`, 'u'),
  );
  for (const block of [gatewayOut, webIn]) {
    assert.doesNotMatch(block, /namespaceSelector|ipBlock|agent-runtime/u);
  }
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');
  assert.match(
    deployments,
    /if eq \$name "gateway" \}\}\n(?: *#.*\n)* *- \{ name: GATEWAY_CONTROL_PLANE_ORIGIN, value: \{\{ printf "http:\/\/agent-workspace-web:%v" \(index \$ports "web"\) \| quote \}\} \}/u,
  );
});

test('the chart opens the object store, the model providers and the Kubernetes API, and no more', async () => {
  const policy = await networkPolicy();
  const base = await read('infra/helm/agent-workspace/values.yaml');
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));

  const objectStore = policy('web-to-object-store');
  assert.match(objectStore, /app\.kubernetes\.io\/name: agent-workspace-web \}/u);
  assert.match(objectStore, /port: \{\{ \.Values\.objectStore\.port \}\}/u);
  assert.match(objectStore, /include "agent-workspace\.egressTo" \.Values\.objectStore/u);

  const providers = policy('agent-workspace-providers');
  assert.deepEqual(selectedPods(providers), ['agent-workspace-web', 'agent-workspace-gateway']);
  assert.match(providers, /port: \{\{ \.Values\.providers\.port \}\}/u);
  assert.match(providers, /include "agent-workspace\.egressTo" \.Values\.providers/u);
  assert.match(
    base,
    /^providers:\n {2}port: 443\n {2}cidr: 0\.0\.0\.0\/0\n {2}except: \[10\.0\.0\.0\/8, 172\.16\.0\.0\/12, 192\.168\.0\.0\/16, 169\.254\.0\.0\/16\]$/mu,
  );

  const api = policy('runner-manager-to-kubernetes-api');
  assert.match(api, /app\.kubernetes\.io\/name: agent-workspace-runner-manager \}/u);
  assert.match(api, /range \.Values\.kubernetesApi\.ports/u);
  assert.match(api, /ipBlock: \{ cidr: \{\{ \. \| quote \}\} \}/u);
  assert.match(base, /^kubernetesApi:\n {2}cidr: ''\n {2}ports: \[443, 6443\]$/mu);

  for (const key of ['objectStore', 'providers', 'kubernetesApi']) {
    assert.equal(schema.properties[key].additionalProperties, false, key);
  }
  assert.equal(schema.properties.providers.properties.except.type, 'array');
});

test('the chart lets the runner manager reach the sandboxes it creates, and only them', async () => {
  const policy = await networkPolicy();
  const policies = await read('infra/helm/agent-workspace/templates/networkpolicy.yaml');
  assert.match(policies, /\{\{- if eq \.Values\.runtime\.driver "kubernetes" \}\}/u);

  const out = policy('runner-manager-to-agent-runtime');
  assert.match(out, /policyTypes: \[Egress\]/u);
  assert.match(out, /matchLabels: \{ app\.kubernetes\.io\/name: agent-runtime \}/u);
  assert.match(out, /port: 8080/u);

  const sandboxIn = policy('agent-runtime-from-runner-manager');
  assert.match(sandboxIn, /policyTypes: \[Ingress\]/u);
  assert.match(
    sandboxIn,
    /from: \[\{ podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/name: agent-workspace-runner-manager/u,
  );
  assert.match(sandboxIn, /port: 8080/u);

  const gatewayIn = policy('gateway-from-agent-runtime');
  assert.match(gatewayIn, /policyTypes: \[Ingress\]/u);
  assert.match(
    gatewayIn,
    /from: \[\{ podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/name: agent-runtime/u,
  );
  assert.match(gatewayIn, /port: 4000/u);
});

test('the runner manager creates sandbox Pods under a namespaced Role and runs one replica', async () => {
  const serviceAccounts = await read('infra/helm/agent-workspace/templates/serviceaccount.yaml');
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');
  const autoscalers = await read(
    'infra/helm/agent-workspace/templates/horizontalpodautoscalers.yaml',
  );
  const base = await read('infra/helm/agent-workspace/values.yaml');
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));

  // Namespaced, never cluster-wide: the sandboxes live in the release namespace.
  assert.doesNotMatch(serviceAccounts, /ClusterRole/u);
  // Exactly what the shared-namespace driver uses: no `serviceaccounts` or `pods/log`.
  const rules = [
    ...serviceAccounts.matchAll(/resources: (\[[^\]]*\])\n(?:\s*#.*\n)*\s+verbs: (\[[^\]]*\])/gu),
  ].map(([, resources, verbs]) => [JSON.parse(resources), JSON.parse(verbs)]);
  assert.deepEqual(rules, [
    [['pods'], ['get', 'list', 'watch', 'create', 'delete']],
    [['services'], ['get', 'create', 'delete']],
    [['networkpolicies'], ['get', 'list', 'watch', 'create', 'delete']],
  ]);
  assert.equal([...serviceAccounts.matchAll(/^\s+- apiGroups:/gmu)].length, rules.length);
  // The sandbox identity holds no Role and no token.
  assert.match(serviceAccounts, /name: agent-runtime\nautomountServiceAccountToken: false/u);

  for (const name of [
    'RUNTIME_KUBERNETES_NAMESPACE',
    'RUNTIME_GATEWAY_SERVICE',
    'AGENT_WORKSPACE_EGRESS_PROXY_IMAGE',
  ]) {
    assert.match(deployments, new RegExp(name, 'u'), name);
  }
  assert.match(deployments, /fieldPath: metadata\.namespace/u);
  assert.match(
    deployments,
    /RUNTIME_DRIVER, value: \{\{ \$\.Values\.runtime\.driver \| quote \}\}/u,
  );
  assert.match(base, /^runtime:\n {2}driver: kubernetes\n {2}egressProxyImage: ''$/mu);
  assert.match(base, /^ {2}runnerManager: 1$/mu);
  assert.equal(schema.properties.runtime.additionalProperties, false);

  // The allocation registry is process-local, so the manager is neither autoscaled nor given more
  // than the replicas the values state.
  assert.match(autoscalers, /range \$name := list "web" "gateway"/u);
  assert.match(
    deployments,
    /or \(not \$\.Values\.autoscaling\.enabled\) \(eq \$name "runner-manager"\)/u,
  );
});

test('the chart renders an Ingress with cert-manager TLS only when asked, and carries the policy', async () => {
  const ingress = await read('infra/helm/agent-workspace/templates/ingress.yaml');
  const policies = await read('infra/helm/agent-workspace/templates/networkpolicy.yaml');
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');
  const base = await read('infra/helm/agent-workspace/values.yaml');
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));

  assert.match(ingress, /^\{\{- if \.Values\.ingress\.enabled \}\}/u);
  assert.match(ingress, /required "ingress\.host is required when ingress\.enabled"/u);
  assert.match(
    ingress,
    /cert-manager\.io\/cluster-issuer: \{\{ \.Values\.ingress\.tls\.clusterIssuer \| quote \}\}/u,
  );
  assert.match(ingress, /secretName: agent-workspace-tls/u);
  assert.match(ingress, /service: \{ name: agent-workspace-web, port: \{ number: 3000 \} \}/u);
  assert.match(base, /^ingress:\n {2}enabled: false$/mu);
  assert.equal(schema.properties.ingress.additionalProperties, false);

  assert.match(
    policies,
    /\{\{- if \.Values\.ingress\.enabled \}\}[\s\S]*web-from-ingress-controller[\s\S]*port: 3000/u,
  );

  assert.match(
    deployments,
    /if and \(eq \$name "web"\) \$\.Values\.deploymentPolicy[\s\S]*name: AW_DEPLOYMENT_POLICY, value: \{\{ \$\.Values\.deploymentPolicy \| quote \}\}/u,
  );
  assert.match(base, /^deploymentPolicy: ''$/mu);
  assert.deepEqual(schema.properties.deploymentPolicy, { type: 'string' });

  // ADR-0160 D5 (#1495): the project's features, rendered only when set, so an empty value
  // renders the web Deployment exactly as before.
  assert.match(
    deployments,
    /if and \(eq \$name "web"\) \$\.Values\.deploymentFeatures[\s\S]*name: AW_DEPLOYMENT_FEATURES, value: \{\{ \$\.Values\.deploymentFeatures \| quote \}\}/u,
  );
  assert.match(base, /^deploymentFeatures: ''$/mu);
  assert.deepEqual(schema.properties.deploymentFeatures, {
    type: 'string',
    pattern: '^([a-z]+(,[a-z]+)*)?$',
  });

  assert.match(
    deployments,
    /if and \(eq \$name "web"\) \$\.Values\.publicUrl[\s\S]*name: AW_PUBLIC_URL, value: \{\{ \$\.Values\.publicUrl \| quote \}\}/u,
  );
  assert.match(base, /^publicUrl: ''$/mu);
  assert.deepEqual(schema.properties.publicUrl, { type: 'string' });
});
