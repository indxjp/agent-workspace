import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  REQUIRED_GCP_APIS,
  REQUIRED_GCP_PERMISSIONS,
  renderPreflightReport,
} from './gcp-preflight.js';
import {
  BILLING_COMMAND,
  ONLY_RUN_ENABLED,
  PROJECT,
  PROJECT_NUMBER_COMMAND,
  SERVICES_ENABLE_COMMAND,
  SERVICES_LIST_COMMAND,
  TOKEN,
  enforcedPolicy,
  failed,
  missingTool,
  ok,
  policyKey,
  setup,
  status,
  terraformVersion,
  withoutPermission,
} from './gcp-preflight.test-support.js';

const EXPECTED_CHECK_IDS = [
  'gcloud',
  'sign-in',
  'gcloud-account',
  'project',
  'permissions',
  'billing',
  'apis',
  'vertex-model',
  'org-policy-public-access',
  'org-policy-private-network',
  'terraform',
  'docker-buildx',
];

const ALERT_PERMISSION_ROLES = [
  ['logging.logMetrics.create', 'roles/logging.configWriter'],
  ['monitoring.dashboards.create', 'roles/monitoring.dashboardEditor'],
  ['monitoring.alertPolicies.create', 'roles/monitoring.alertPolicyEditor'],
  ['monitoring.notificationChannels.create', 'roles/monitoring.notificationChannelEditor'],
  ['monitoring.uptimeCheckConfigs.create', 'roles/monitoring.uptimeCheckConfigEditor'],
];

describe('runGcpPreflight overall report', () => {
  it('passes every check when everything is in place', async () => {
    const { run } = setup();
    const report = await run();
    expect(report.passed).toBe(true);
    expect(report.projectNumber).toBe('123456789');
    expect(report.checks.every((entry) => entry.status === 'ok')).toBe(true);
    expect(report.checks.map((entry) => entry.id)).toEqual(EXPECTED_CHECK_IDS);
  });

  it('runs every check even when the first fails', async () => {
    const { run, calls, requests } = setup({ overrides: { 'gcloud --version': failed } });
    const report = await run();
    expect(report.checks).toHaveLength(12);
    expect(calls.at(-1)).toBe('docker buildx version');
    expect(requests).toHaveLength(2);
  });

  it('never prints the token', async () => {
    const { run, out, err } = setup({ overrides: { 'docker buildx version': failed } });
    const report = await run();
    const printed = [...out, ...err, renderPreflightReport(report), JSON.stringify(report)].join(
      '',
    );
    expect(printed).not.toContain(TOKEN);
    expect(printed).toContain('$ gcloud auth application-default print-access-token');
  });
});

describe('runGcpPreflight tools and sign-in', () => {
  it('fails when gcloud is missing, with the install URL, and still runs every other check', async () => {
    const { run, calls } = setup({ overrides: { 'gcloud --version': missingTool } });
    const report = await run();
    expect(status(report, 'gcloud')).toMatchObject({
      status: 'fail',
      fix: 'https://cloud.google.com/sdk/docs/install',
    });
    expect(calls).toContain('docker buildx version');
    expect(calls).toContain('terraform version -json');
    expect(report.passed).toBe(false);
  });

  it('checks sign-in by exit code', async () => {
    const { run } = setup({
      overrides: { 'gcloud auth application-default print-access-token': failed },
    });
    const report = await run();
    expect(status(report, 'sign-in')).toMatchObject({
      status: 'fail',
      fix: 'gcloud auth application-default login',
    });
  });

  it('requires gcloud own account, and reports sign-in rather than a missing project', async () => {
    const { run } = setup({
      overrides: { 'gcloud auth print-access-token': failed, [PROJECT_NUMBER_COMMAND]: failed },
    });
    const report = await run();
    expect(status(report, 'gcloud-account')).toMatchObject({
      status: 'fail',
      fix: 'gcloud auth login',
    });
    expect(status(report, 'project')).toMatchObject({ status: 'fail', fix: 'gcloud auth login' });
    expect(status(report, 'permissions')?.fix).toBe('gcloud auth login');
  });

  it('chooses the Terraform archive for the machine, else the download page', async () => {
    const overrides = { 'terraform version -json': missingTool };
    const linux = await setup({ overrides }).run();
    expect(status(linux, 'terraform')?.fix).toContain('terraform_1.9.8_linux_amd64.zip');
    const mac = await setup({ overrides, host: { platform: 'darwin', arch: 'arm64' } }).run();
    expect(status(mac, 'terraform')?.fix).toContain('terraform_1.9.8_darwin_arm64.zip');
    const windows = await setup({ overrides, host: { platform: 'win32', arch: 'x64' } }).run();
    expect(status(windows, 'terraform')?.fix).toBe(
      'https://developer.hashicorp.com/terraform/install',
    );
  });

  it('fails when the project is not found', async () => {
    const { run } = setup({ overrides: { [PROJECT_NUMBER_COMMAND]: failed } });
    const report = await run();
    expect(status(report, 'project')?.status).toBe('fail');
    expect(report.projectNumber).toBeUndefined();
  });
});

describe('runGcpPreflight permissions', () => {
  it('asks testIamPermissions with the bearer token and names the missing permissions', async () => {
    const { run, requests } = setup({ granted: REQUIRED_GCP_PERMISSIONS.slice(1) });
    const report = await run();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      `https://cloudresourcemanager.googleapis.com/v3/projects/${PROJECT}:testIamPermissions`,
    );
    expect(JSON.stringify(requests[0]?.init)).toContain(`Bearer ${TOKEN}`);
    const permissions = status(report, 'permissions');
    expect(permissions?.status).toBe('fail');
    expect(permissions?.title).toContain('resourcemanager.projects.get');
    expect(permissions?.fix).toContain('roles/resourcemanager.projectIamAdmin');
    expect(permissions?.fix).not.toContain('roles/owner');
  });

  it('requires iam.serviceAccounts.actAs and names roles/iam.serviceAccountUser for it', async () => {
    const granted = withoutPermission('iam.serviceAccounts.actAs');
    const permissions = status(await setup({ granted }).run(), 'permissions');
    expect(permissions?.status).toBe('fail');
    expect(permissions?.title).toContain('iam.serviceAccounts.actAs');
    expect(permissions?.fix).toContain('roles/iam.serviceAccountUser');
  });

  it.each(ALERT_PERMISSION_ROLES)(
    'requires %s and names %s when it is missing',
    async (permission, role) => {
      const granted = withoutPermission(permission ?? '');
      const report = await setup({ granted }).run(false, { alertsEmail: 'oncall@example.com' });
      const permissions = status(report, 'permissions');
      expect(permissions?.status).toBe('fail');
      expect(permissions?.title).toContain(permission);
      expect(permissions?.fix).toContain(role);
    },
  );

  it('requires iam.roles.create for the runner manager custom roles and names roles/iam.roleAdmin', async () => {
    const granted = withoutPermission('iam.roles.create');
    const permissions = status(await setup({ granted }).run(), 'permissions');
    expect(permissions?.status).toBe('fail');
    expect(permissions?.title).toContain('iam.roles.create');
    expect(permissions?.fix).toContain('roles/iam.roleAdmin');
  });

  it('asks for no alerting permission unless gcp.alertsEmail is set', async () => {
    const granted = REQUIRED_GCP_PERMISSIONS.filter(
      (p) =>
        !p.startsWith('monitoring.a') &&
        p !== 'monitoring.notificationChannels.create' &&
        p !== 'monitoring.uptimeCheckConfigs.create',
    );
    const { run, requests } = setup({ granted });
    expect(status(await run(), 'permissions')?.status).toBe('ok');
    expect(JSON.stringify(requests[0]?.init)).not.toContain('alertPolicies');
    const withAlerts = await setup({ granted }).run(false, { alertsEmail: 'a@b.co' });
    expect(status(withAlerts, 'permissions')?.status).toBe('fail');
  });

  it('fails the permission check when no token can be had', async () => {
    const { run, requests } = setup({ overrides: { 'gcloud auth print-access-token': failed } });
    const report = await run();
    expect(requests).toHaveLength(0);
    expect(status(report, 'permissions')?.status).toBe('fail');
  });
});

describe('runGcpPreflight billing and APIs', () => {
  it('fails billing when it is off and warns when it cannot be read', async () => {
    const off = await setup({ overrides: { [BILLING_COMMAND]: ok('False\n') } }).run();
    expect(status(off, 'billing')).toMatchObject({
      status: 'fail',
      fix: `https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT}`,
    });
    const unknown = await setup({ overrides: { [BILLING_COMMAND]: failed } }).run();
    expect(status(unknown, 'billing')?.status).toBe('warn');
    expect(unknown.passed).toBe(true);
  });

  it('warns with one enable command when APIs are missing', async () => {
    const { run, calls } = setup({ overrides: { [SERVICES_LIST_COMMAND]: ONLY_RUN_ENABLED } });
    const report = await run();
    const apis = status(report, 'apis');
    expect(apis?.status).toBe('warn');
    expect(apis?.fix).toBe(SERVICES_ENABLE_COMMAND);
    expect(calls.some((line) => line.includes('services enable'))).toBe(false);
  });

  it('creates nothing when any check fails, even with apply', async () => {
    const { run, calls } = setup({
      overrides: { [SERVICES_LIST_COMMAND]: ok(''), 'docker buildx version': failed },
    });
    const report = await run(true);
    expect(report.passed).toBe(false);
    expect(status(report, 'apis')?.status).toBe('warn');
    expect(calls.some((line) => line.includes('services enable'))).toBe(false);
  });

  it('enables the missing APIs once when apply is set and every check is green', async () => {
    const { run, calls } = setup({
      overrides: { [SERVICES_LIST_COMMAND]: ONLY_RUN_ENABLED, [SERVICES_ENABLE_COMMAND]: ok() },
    });
    const report = await run(true);
    expect(calls.filter((line) => line.includes('services enable'))).toEqual([
      SERVICES_ENABLE_COMMAND,
    ]);
    expect(status(report, 'apis')?.status).toBe('fixed');
    expect(report.passed).toBe(true);
  });

  it('does not enable anything when apply is off', async () => {
    const { run, calls } = setup();
    await run();
    expect(calls.some((line) => line.includes('services enable'))).toBe(false);
  });
});

describe('runGcpPreflight build tools', () => {
  it('fails on Terraform that is missing or older than 1.8.0', async () => {
    const old = await setup({
      overrides: { 'terraform version -json': terraformVersion('1.7.9') },
    }).run();
    expect(status(old, 'terraform')?.status).toBe('fail');
    expect(status(old, 'terraform')?.fix).toContain('~/bin');
    const absent = await setup({ overrides: { 'terraform version -json': missingTool } }).run();
    expect(status(absent, 'terraform')?.status).toBe('fail');
    const exact = await setup({
      overrides: { 'terraform version -json': terraformVersion('1.8.0') },
    }).run();
    expect(status(exact, 'terraform')?.status).toBe('ok');
  });

  it('fails when docker buildx does not answer', async () => {
    const report = await setup({ overrides: { 'docker buildx version': failed } }).run();
    expect(status(report, 'docker-buildx')?.status).toBe('fail');
  });
});

describe('REQUIRED_GCP_APIS', () => {
  it('equals the locals.required_apis of the Cloud Run module', async () => {
    const main = await readFile(
      fileURLToPath(new URL('../../modules/gcp-cloudrun/main.tf', import.meta.url)),
      'utf8',
    );
    const block = /required_apis\s*=\s*toset\(\[([^\]]*)\]\)/.exec(main)?.[1] ?? '';
    const declared = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect([...REQUIRED_GCP_APIS].sort()).toEqual([...declared].sort());
  });
});

describe('renderPreflightReport', () => {
  it('renders one failure screen', async () => {
    const report = await setup({
      overrides: {
        'gcloud auth application-default print-access-token': failed,
        'gcloud auth print-access-token': failed,
        [SERVICES_LIST_COMMAND]: ONLY_RUN_ENABLED,
        'terraform version -json': missingTool,
        [policyKey('run.allowedIngress')]: enforcedPolicy(),
        [policyKey('run.allowedVPCEgress')]: enforcedPolicy(),
      },
    }).run(false, {
      domain: 'agents.example.com',
      loadBalancerIp: () => Promise.resolve('203.0.113.7'),
      resolveHost: () => Promise.resolve({ address: '198.51.100.1', family: 4 }),
    });
    await expect(renderPreflightReport(report)).toMatchFileSnapshot(
      './fixtures/gcp-preflight/failure-screen.txt',
    );
  });
});
