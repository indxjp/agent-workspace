import assert from 'node:assert/strict';
import test from 'node:test';

import { read } from './contracts.test-support.mjs';
import './contracts-rendered.test.mjs';
import './contracts-chart.test.mjs';
import './contracts-network.test.mjs';

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

test('the runner manager reads the Artifact Registry repository its runtime image is in (#2108)', async () => {
  // Cloud Run's create-service API checks that the caller can read the image, and `aw deploy`
  // uses an image already in Artifact Registry in place (live run 42011318769: a 403 on CI's
  // staging repository), so the stack's own repository alone is not enough.
  for (const file of [
    'infra/terraform/gcp-cloudrun/main.tf',
    'packages/cli/modules/gcp-cloudrun/main.tf',
  ]) {
    const terraform = await read(file);
    assert.match(
      terraform,
      /resource "google_artifact_registry_repository_iam_member" "runner_manager_artifact_reader" \{[^}]*repository\s*=\s*google_artifact_registry_repository\.images\.repository_id[^}]*roles\/artifactregistry\.reader/u,
      `${file} lets the runner manager read the stack's repository`,
    );
    assert.match(
      terraform,
      /resource "google_artifact_registry_repository_iam_member" "runner_manager_runtime_image_reader" \{\n\s*count\s*=\s*local\.runtime_image_elsewhere \? 1 : 0\n\s*project\s*=\s*var\.project_id\n\s*location\s*=\s*local\.runtime_image_repository\.location\n\s*repository\s*=\s*local\.runtime_image_repository\.repository\n\s*role\s*=\s*"roles\/artifactregistry\.reader"\n\s*member\s*=\s*google_service_account\.runner_manager\.member/u,
      `${file} lets the runner manager read only the runtime image's own repository in this project`,
    );
    assert.match(terraform, /regex\("[^"]*docker[^"]*", var\.images\.runtime\)/u, file);
    // No project-wide Artifact Registry role for the runner manager.
    const projectGrants = (
      terraform.match(/^resource "google_project_iam_member" "[^"]+" \{[\s\S]*?^\}/gmu) ?? []
    ).filter((block) => /roles\/artifactregistry\./u.test(block) && /runner_manager/u.test(block));
    assert.deepEqual(
      projectGrants,
      [],
      `${file} grants the runner manager no project-wide registry role`,
    );
  }
  for (const file of [
    'infra/terraform/gcp-cloudrun/network.tf',
    'packages/cli/modules/gcp-cloudrun/network.tf',
  ]) {
    assert.match(
      await read(file),
      /resource "terraform_data" "input_checks"[\s\S]*?condition\s*=\s*local\.runtime_image_in_project/u,
      `${file} refuses a runtime image outside this project's Artifact Registry`,
    );
  }
});

test('both Cloud Run module copies write the dashboard in the Monitoring API canonical form (#2105)', async () => {
  for (const module of ['infra/terraform/gcp-cloudrun', 'packages/cli/modules/gcp-cloudrun']) {
    const monitoring = await read(`${module}/monitoring.tf`);
    const dashboard = monitoring.match(
      /^resource "google_monitoring_dashboard" "main" \{[\s\S]*?^\}/mu,
    )?.[0];
    assert.ok(dashboard, `${module} declares the dashboard`);
    assert.match(
      dashboard,
      /columns = "2"/u,
      `${module}: gridLayout.columns is the string the API reads back`,
    );
    assert.doesNotMatch(
      dashboard,
      /columns = \d/u,
      `${module}: gridLayout.columns is not a number`,
    );
    const dataSets = dashboard.match(/dataSets = \[\{[\s\S]*?timeSeriesQuery/gu) ?? [];
    assert.ok(dataSets.length > 0, `${module} has xyChart dataSets`);
    for (const dataSet of dataSets) {
      assert.match(dataSet, /plotType\s*= "LINE"/u, `${module}: every dataSet sets plotType LINE`);
      assert.match(dataSet, /targetAxis\s*= "Y1"/u, `${module}: every dataSet sets targetAxis Y1`);
    }
  }
});

test('a Cloud Run sandbox reaches only the gateway internal load balancer, never a Google VIP (#2109)', async () => {
  const vips = ['199.36.153.8/30', '199.36.153.4/30'];
  for (const module of ['infra/terraform/gcp-cloudrun', 'packages/cli/modules/gcp-cloudrun']) {
    const network = await read(`${module}/network.tf`);
    const firewalls =
      network.match(/^resource "google_compute_firewall" "[^"]+" \{[\s\S]*?^\}/gmu) ?? [];
    const sandbox = firewalls.filter((block) => /target_tags\s*=\s*\["aw-sandbox"\]/u.test(block));
    const allows = sandbox.filter((block) => /^\s*allow \{/mu.test(block));
    assert.equal(allows.length, 1, `${module} has exactly one aw-sandbox allow rule`);
    for (const block of allows) {
      assert.match(
        block,
        /destination_ranges\s*=\s*\["\$\{local\.sandbox_allowed_ip\}\/32"\]/u,
        `${module}: the aw-sandbox allow rule targets the gateway's internal address only`,
      );
      assert.match(
        block,
        /ports\s*=\s*\["80"\]/u,
        `${module}: the aw-sandbox allow rule is tcp 80 only`,
      );
      for (const vip of vips)
        assert.ok(!block.includes(vip), `${module}: no aw-sandbox allow rule targets ${vip}`);
    }
    const vipDeny = sandbox.find((block) =>
      /destination_ranges\s*=\s*local\.google_vip_cidrs/u.test(block),
    );
    assert.ok(vipDeny, `${module} denies the Google VIPs to aw-sandbox in their own rule`);
    assert.match(
      vipDeny,
      /deny \{\s*protocol = "all"\s*\}/u,
      `${module}: the VIP deny covers every protocol and port`,
    );
    assert.match(vipDeny, /priority\s*=\s*0/u, `${module}: the VIP deny sits at priority 0`);
    assert.match(
      network,
      /google_vip_cidrs = \["199\.36\.153\.8\/30", "199\.36\.153\.4\/30"\]/u,
      `${module} names both Google VIP ranges`,
    );
    assert.match(
      network,
      /resource "google_compute_forwarding_rule" "gateway" \{[\s\S]*?load_balancing_scheme = "INTERNAL_MANAGED"/u,
      `${module} fronts the gateway with an internal Application Load Balancer`,
    );
    const main = await read(`${module}/main.tf`);
    assert.match(
      main,
      /name {2}= "MODEL_GATEWAY_URL"\n\s*value = local\.gateway_internal_url\n/u,
      `${module}: web hands sandboxes the internal load balancer URL`,
    );
  }
});

test('web announces the Cloud Run egress proxy only when sandbox_internet is on (#2105)', async () => {
  // network-policy.ts accepts restricted and open for cloud-run-service only when web has
  // RUNTIME_EGRESS_PROXY_URL; the runner manager signs with the key against the same URL.
  const webOf = (terraform) =>
    terraform.split('resource "google_cloud_run_v2_service" "web"')[1]?.split(/^resource /mu)[0] ??
    '';
  const proxyUrl =
    /dynamic "env" \{\n(?:\s*#.*\n)*\s*for_each = var\.sandbox_internet \? \[1\] : \[\]\n\s*content \{\n\s*name {2}= "RUNTIME_EGRESS_PROXY_URL"\n\s*value = "http:\/\/\$\{google_compute_address\.egress_proxy\[0\]\.address\}:\$\{local\.egress_proxy_port\}"\n/u;
  for (const module of ['infra/terraform/gcp-cloudrun', 'packages/cli/modules/gcp-cloudrun']) {
    const main = await read(`${module}/main.tf`);
    const web = webOf(main);
    assert.match(web, proxyUrl, `${module}: web gets the proxy URL behind sandbox_internet`);
    assert.equal(
      [...web.matchAll(/"RUNTIME_EGRESS_PROXY_URL"/gu)].length,
      1,
      `${module}: web sets RUNTIME_EGRESS_PROXY_URL once, in that block`,
    );
    assert.doesNotMatch(
      web,
      /RUNTIME_EGRESS_PROXY_KEY/u,
      `${module}: web never reads the credential key`,
    );
    const runnerManager =
      main
        .split('resource "google_cloud_run_v2_service" "runner_manager"')[1]
        ?.split(/^resource /mu)[0] ?? '';
    assert.match(runnerManager, proxyUrl, `${module}: the runner manager gets the same proxy URL`);
    assert.match(
      runnerManager,
      /name = "RUNTIME_EGRESS_PROXY_KEY"/u,
      `${module}: the runner manager gets the key`,
    );
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
    const terraform = await read(file);
    const gateway = gatewayOf(terraform, 'google_cloud_run_v2_service');
    // The gateway reaches web at its deterministic run.app URL, even when a domain is set.
    assert.match(
      gateway,
      /name\s*=\s*"GATEWAY_CONTROL_PLANE_ORIGIN"\n(\s*#.*\n)*\s*value\s*=\s*local\.run_app_origin\n/u,
      file,
    );
    assert.match(
      terraform,
      /run_app_origin\s*=\s*"https:\/\/\$\{var\.name\}-web-\$\{data\.google_project\.current\.number\}\.\$\{var\.region\}\.run\.app"/u,
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
