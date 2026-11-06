import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  REQUIRED_GCP_APIS,
  REQUIRED_GCP_PERMISSIONS,
  renderPreflightReport,
  runGcpPreflight,
  type GcpPreflightInput,
  type GcpPreflightReport,
} from './gcp-preflight.js';
import type { ToolInvocation, ToolResult } from './runner.js';
import type { DeployContext } from './steps.js';

const TOKEN = 'ya29.SECRET-TOKEN-VALUE';
const PROJECT = 'acme-prod';

type Answer = ToolResult | Error;
type Answers = Readonly<Record<string, Answer>>;

const ok = (stdout = ''): ToolResult => ({ status: 0, stdout, stderr: '' });
const failed: ToolResult = { status: 1, stdout: '', stderr: 'boom' };
const missingTool = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

const ALL_APIS = REQUIRED_GCP_APIS.join('\n');
const NO_POLICY = ok('{}');

const GREEN: Answers = {
  'gcloud --version': ok('Google Cloud SDK 500.0.0'),
  'gcloud auth application-default print-access-token': ok(TOKEN),
  'gcloud auth print-access-token': ok(TOKEN),
  [`gcloud projects describe ${PROJECT} --format=value(projectNumber)`]: ok('123456789\n'),
  [`gcloud billing projects describe ${PROJECT} --format=value(billingEnabled)`]: ok('True\n'),
  [`gcloud services list --enabled --project ${PROJECT} --format=value(config.name)`]: ok(ALL_APIS),
  'terraform version -json': ok(JSON.stringify({ terraform_version: '1.9.8' })),
  'docker buildx version': ok('github.com/docker/buildx v0.17.0'),
};

function policyKey(constraint: string): string {
  return `gcloud org-policies describe ${constraint} --project ${PROJECT} --effective --format=json`;
}

function setup(
  overrides: Answers = {},
  granted: readonly string[] = REQUIRED_GCP_PERMISSIONS,
  host = { platform: 'linux', arch: 'x64' },
  vertex: number | Error = 200,
  modelLocation?: 'global' | 'us' | 'eu',
  vertexMessage = 'secret detail',
  vertexReason?: string,
) {
  const answers: Answers = { ...GREEN, ...overrides };
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const context: DeployContext = {
    runner: (invocation: ToolInvocation) => {
      const line = [invocation.tool, ...invocation.args].join(' ');
      calls.push(line);
      const answer = answers[line] ?? (line.includes('org-policies') ? NO_POLICY : failed);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    directory: '/project',
    env: {},
    cloud: 'gcp',
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  const fetchStub: typeof fetch = (url, init) => {
    requests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      init,
    });
    if (requests.at(-1)?.url.includes(':rawPredict')) {
      return vertex instanceof Error
        ? Promise.reject(vertex)
        : Promise.resolve(
            Response.json(
              {
                error: {
                  message: vertexMessage,
                  ...(vertexReason ? { status: vertexReason } : {}),
                },
              },
              { status: vertex },
            ),
          );
    }
    return Promise.resolve(Response.json({ permissions: granted }));
  };
  const run = (apply = false, extra: Partial<GcpPreflightInput> = {}) =>
    runGcpPreflight({
      context,
      project: PROJECT,
      region: 'europe-west1',
      apply,
      fetch: fetchStub,
      host,
      ...(modelLocation === undefined ? {} : { modelLocation }),
      ...extra,
    });
  return { run, calls, out, err, requests };
}

function status(report: GcpPreflightReport, id: string) {
  return report.checks.find((entry) => entry.id === id);
}

describe('runGcpPreflight', () => {
  it('passes every check when everything is in place', async () => {
    const { run } = setup();
    const report = await run();
    expect(report.passed).toBe(true);
    expect(report.projectNumber).toBe('123456789');
    expect(report.checks.every((entry) => entry.status === 'ok')).toBe(true);
    expect(report.checks.map((entry) => entry.id)).toEqual([
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
    ]);
  });

  it('fails when gcloud is missing, with the install URL, and still runs every other check', async () => {
    const { run, calls } = setup({ 'gcloud --version': missingTool });
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
    const { run } = setup({ 'gcloud auth application-default print-access-token': failed });
    const report = await run();
    expect(status(report, 'sign-in')).toMatchObject({
      status: 'fail',
      fix: 'gcloud auth application-default login',
    });
  });

  it('requires gcloud own account, and reports sign-in rather than a missing project', async () => {
    const { run } = setup({
      'gcloud auth print-access-token': failed,
      [`gcloud projects describe ${PROJECT} --format=value(projectNumber)`]: failed,
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
    const missing = { 'terraform version -json': missingTool };
    const linux = await setup(missing).run();
    expect(status(linux, 'terraform')?.fix).toContain('terraform_1.9.8_linux_amd64.zip');
    const mac = await setup(missing, REQUIRED_GCP_PERMISSIONS, {
      platform: 'darwin',
      arch: 'arm64',
    }).run();
    expect(status(mac, 'terraform')?.fix).toContain('terraform_1.9.8_darwin_arm64.zip');
    const windows = await setup(missing, REQUIRED_GCP_PERMISSIONS, {
      platform: 'win32',
      arch: 'x64',
    }).run();
    expect(status(windows, 'terraform')?.fix).toBe(
      'https://developer.hashicorp.com/terraform/install',
    );
  });

  it('fails when the project is not found', async () => {
    const { run } = setup({
      [`gcloud projects describe ${PROJECT} --format=value(projectNumber)`]: failed,
    });
    const report = await run();
    expect(status(report, 'project')?.status).toBe('fail');
    expect(report.projectNumber).toBeUndefined();
  });

  it('asks testIamPermissions with the bearer token and names the missing permissions', async () => {
    const { run, requests } = setup({}, REQUIRED_GCP_PERMISSIONS.slice(1));
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
    const granted = REQUIRED_GCP_PERMISSIONS.filter((p) => p !== 'iam.serviceAccounts.actAs');
    const permissions = status(await setup({}, granted).run(), 'permissions');
    expect(permissions?.status).toBe('fail');
    expect(permissions?.title).toContain('iam.serviceAccounts.actAs');
    expect(permissions?.fix).toContain('roles/iam.serviceAccountUser');
  });

  it.each([
    ['logging.logMetrics.create', 'roles/logging.configWriter'],
    ['monitoring.dashboards.create', 'roles/monitoring.dashboardEditor'],
    ['monitoring.alertPolicies.create', 'roles/monitoring.alertPolicyEditor'],
    ['monitoring.notificationChannels.create', 'roles/monitoring.notificationChannelEditor'],
    ['monitoring.uptimeCheckConfigs.create', 'roles/monitoring.uptimeCheckConfigEditor'],
  ])('requires %s and names %s when it is missing', async (permission, role) => {
    const granted = REQUIRED_GCP_PERMISSIONS.filter((p) => p !== permission);
    const permissions = status(
      await setup({}, granted).run(false, { alertsEmail: 'oncall@example.com' }),
      'permissions',
    );
    expect(permissions?.status).toBe('fail');
    expect(permissions?.title).toContain(permission);
    expect(permissions?.fix).toContain(role);
  });

  it('asks for no alerting permission unless gcp.alertsEmail is set', async () => {
    const granted = REQUIRED_GCP_PERMISSIONS.filter(
      (p) =>
        !p.startsWith('monitoring.a') &&
        p !== 'monitoring.notificationChannels.create' &&
        p !== 'monitoring.uptimeCheckConfigs.create',
    );
    const { run, requests } = setup({}, granted);
    expect(status(await run(), 'permissions')?.status).toBe('ok');
    expect(JSON.stringify(requests[0]?.init)).not.toContain('alertPolicies');
    expect(
      status(await setup({}, granted).run(false, { alertsEmail: 'a@b.co' }), 'permissions')?.status,
    ).toBe('fail');
  });

  it('fails the permission check when no token can be had', async () => {
    const { run, requests } = setup({ 'gcloud auth print-access-token': failed });
    const report = await run();
    expect(requests).toHaveLength(0);
    expect(status(report, 'permissions')?.status).toBe('fail');
  });

  it('fails billing when it is off and warns when it cannot be read', async () => {
    const key = `gcloud billing projects describe ${PROJECT} --format=value(billingEnabled)`;
    const off = await setup({ [key]: ok('False\n') }).run();
    expect(status(off, 'billing')).toMatchObject({
      status: 'fail',
      fix: `https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT}`,
    });
    const unknown = await setup({ [key]: failed }).run();
    expect(status(unknown, 'billing')?.status).toBe('warn');
    expect(unknown.passed).toBe(true);
  });

  it('warns with one enable command when APIs are missing', async () => {
    const key = `gcloud services list --enabled --project ${PROJECT} --format=value(config.name)`;
    const { run, calls } = setup({ [key]: ok('run.googleapis.com\n') });
    const report = await run();
    const apis = status(report, 'apis');
    expect(apis?.status).toBe('warn');
    expect(apis?.fix).toBe(
      `gcloud services enable ${REQUIRED_GCP_APIS.slice(1).join(' ')} --project ${PROJECT}`,
    );
    expect(calls.some((line) => line.includes('services enable'))).toBe(false);
  });

  it('fails when the organisation restricts policy member domains', async () => {
    const { run } = setup({
      [policyKey('iam.allowedPolicyMemberDomains')]: ok(
        JSON.stringify({ spec: { rules: [{ values: { allowedValues: ['C0123'] } }] } }),
      ),
    });
    const report = await run();
    const access = status(report, 'org-policy-public-access');
    expect(access?.status).toBe('fail');
    expect(access?.fix).toBeUndefined();
    expect(access?.title).toContain('administrator');
  });

  it('names who can still reach the web app, and the way out, when access is restricted', async () => {
    const restricted = {
      [policyKey('iam.allowedPolicyMemberDomains')]: ok(
        JSON.stringify({ spec: { rules: [{ values: { allowedValues: ['C0123'] } }] } }),
      ),
    };
    const access = status(await setup(restricted).run(), 'org-policy-public-access');
    expect(access?.status).toBe('fail');
    expect(access?.title).toContain(
      "the web app's sign-in page and the gateway must be reachable by anyone (the gateway keeps an allUsers invoker binding whatever gcp.iap is). Ask your administrator for an exception for project acme-prod",
    );
    expect(access?.title).not.toContain('later release');
    expect(access?.fix).toBeUndefined();
    const withIap = await setup(restricted).run(false, { domain: 'agents.example.com', iap: true });
    expect(status(withIap, 'org-policy-public-access')?.status).toBe('fail');
    expect(status(withIap, 'org-policy-public-access')?.title).toContain('gateway');
    const domainOnly = await setup(restricted).run(false, { domain: 'agents.example.com' });
    expect(status(domainOnly, 'org-policy-public-access')?.status).toBe('fail');
  });

  it('is satisfied by the sql public IP policies and warns what ingress and egress policies mean', async () => {
    const enforced = ok(JSON.stringify({ spec: { rules: [{ enforce: true }] } }));
    const sql = await setup({
      [policyKey('sql.restrictPublicIp')]: enforced,
      [policyKey('sql.managed.restrictPublicIp')]: enforced,
    }).run();
    expect(status(sql, 'org-policy-private-network')?.status).toBe('ok');

    const report = await setup({
      [policyKey('run.allowedIngress')]: enforced,
      [policyKey('run.allowedVPCEgress')]: enforced,
    }).run(false, { domain: 'agents.example.com' });
    const network = status(report, 'org-policy-private-network');
    expect(network?.status).toBe('warn');
    expect(network?.title).toContain(
      'run.allowedIngress: the web app stays public (internal-and-cloud-load-balancing, behind the load balancer for agents.example.com) and the runner manager is internal',
    );
    expect(network?.title).toContain('run.allowedVPCEgress: the services use private-ranges-only');
    expect(network?.title).not.toContain('later release');
    expect(network?.fix).toBeUndefined();
    expect(report.passed).toBe(true);
  });

  describe('DNS for gcp.domain', () => {
    const dns = (ip: string | null, addresses: string[] | Error) =>
      setup().run(false, {
        domain: 'agents.example.com',
        loadBalancerIp: () => Promise.resolve(ip),
        resolveHost: (host) =>
          addresses instanceof Error || host !== 'agents.example.com'
            ? Promise.reject(addresses instanceof Error ? addresses : new Error(host))
            : Promise.resolve(addresses.map((address) => ({ address, family: 4 }))),
      });

    it('warns that DNS must follow the deploy before the load balancer exists', async () => {
      const row = status(await dns(null, ['203.0.113.7']), 'dns');
      expect(row?.status).toBe('warn');
      expect(row?.fix).toContain('points at the printed address');
    });

    it('is not checked without a domain', async () => {
      const noDomain = await setup().run(false, {
        loadBalancerIp: () => Promise.resolve('203.0.113.7'),
        resolveHost: () => Promise.resolve([]),
      });
      expect(status(noDomain, 'dns')).toBeUndefined();
    });

    it('is ok when the domain resolves to the load balancer', async () => {
      expect(status(await dns('203.0.113.7', ['198.51.100.1', '203.0.113.7']), 'dns')?.status).toBe(
        'ok',
      );
    });

    it('warns, with the record to create, when the domain does not point there yet', async () => {
      for (const resolved of [['198.51.100.1'], new Error('ENOTFOUND')]) {
        const report = await dns('203.0.113.7', resolved);
        expect(status(report, 'dns')).toMatchObject({
          status: 'warn',
          title:
            'DNS for agents.example.com does not point here yet (203.0.113.7); the certificate is issued once it does',
          fix: 'create this record at your DNS provider: agents.example.com. A 203.0.113.7',
        });
        expect(report.passed).toBe(true);
      }
    });
  });

  it('warns when an org policy cannot be described', async () => {
    const { run } = setup({ [policyKey('iam.allowedPolicyMemberDomains')]: failed });
    const report = await run();
    expect(status(report, 'org-policy-public-access')?.status).toBe('warn');
  });

  it('fails on Terraform that is missing or older than 1.8.0', async () => {
    const old = await setup({
      'terraform version -json': ok(JSON.stringify({ terraform_version: '1.7.9' })),
    }).run();
    expect(status(old, 'terraform')?.status).toBe('fail');
    expect(status(old, 'terraform')?.fix).toContain('~/bin');
    const absent = await setup({ 'terraform version -json': missingTool }).run();
    expect(status(absent, 'terraform')?.status).toBe('fail');
    const exact = await setup({
      'terraform version -json': ok(JSON.stringify({ terraform_version: '1.8.0' })),
    }).run();
    expect(status(exact, 'terraform')?.status).toBe('ok');
  });

  it('fails when docker buildx does not answer', async () => {
    const report = await setup({ 'docker buildx version': failed }).run();
    expect(status(report, 'docker-buildx')?.status).toBe('fail');
  });

  it('runs every check even when the first fails', async () => {
    const { run, calls, requests } = setup({ 'gcloud --version': failed });
    const report = await run();
    expect(report.checks).toHaveLength(12);
    expect(calls.at(-1)).toBe('docker buildx version');
    expect(requests).toHaveLength(2);
  });

  it('creates nothing when any check fails, even with apply', async () => {
    const key = `gcloud services list --enabled --project ${PROJECT} --format=value(config.name)`;
    const { run, calls } = setup({ [key]: ok(''), 'docker buildx version': failed });
    const report = await run(true);
    expect(report.passed).toBe(false);
    expect(status(report, 'apis')?.status).toBe('warn');
    expect(calls.some((line) => line.includes('services enable'))).toBe(false);
  });

  it('enables the missing APIs once when apply is set and every check is green', async () => {
    const key = `gcloud services list --enabled --project ${PROJECT} --format=value(config.name)`;
    const enable = `gcloud services enable ${REQUIRED_GCP_APIS.slice(1).join(' ')} --project ${PROJECT}`;
    const { run, calls } = setup({ [key]: ok('run.googleapis.com\n'), [enable]: ok() });
    const report = await run(true);
    expect(calls.filter((line) => line.includes('services enable'))).toEqual([enable]);
    expect(status(report, 'apis')?.status).toBe('fixed');
    expect(report.passed).toBe(true);
  });

  it('does not enable anything when apply is off', async () => {
    const { run, calls } = setup();
    await run();
    expect(calls.some((line) => line.includes('services enable'))).toBe(false);
  });

  describe('vertex-model', () => {
    const MODEL = 'claude-sonnet-5-5';
    const GARDEN = `https://console.cloud.google.com/vertex-ai/publishers/anthropic/model-garden/${MODEL}?project=${PROJECT}`;

    it('sends one 1-token rawPredict with the bearer token and says where Claude answers', async () => {
      const { run, requests } = setup();
      const report = await run();
      const sent = requests[1];
      expect(sent?.url).toBe(
        `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/anthropic/models/${MODEL}:rawPredict`,
      );
      expect(sent?.init?.method).toBe('POST');
      expect(JSON.stringify(sent?.init?.headers)).toContain(`Bearer ${TOKEN}`);
      expect(JSON.parse(sent?.init?.body as string)).toEqual({
        anthropic_version: 'vertex-2023-10-16',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      expect(status(report, 'vertex-model')).toEqual({
        id: 'vertex-model',
        title: `Claude (${MODEL}) answers in global`,
        status: 'ok',
      });
    });

    it('uses the regional host for us and eu', async () => {
      const us = setup({}, REQUIRED_GCP_PERMISSIONS, undefined, 200, 'us');
      await us.run();
      expect(us.requests[1]?.url).toBe(
        `https://aiplatform.us.rep.googleapis.com/v1/projects/${PROJECT}/locations/us/publishers/anthropic/models/${MODEL}:rawPredict`,
      );
      const eu = setup({}, REQUIRED_GCP_PERMISSIONS, undefined, 200, 'eu');
      const report = await eu.run();
      expect(eu.requests[1]?.url).toContain('https://aiplatform.eu.rep.googleapis.com/');
      expect(status(report, 'vertex-model')?.title).toBe(`Claude (${MODEL}) answers in eu`);
    });

    it.each([
      [404, 'secret detail'],
      [403, 'Publisher Model `claude-sonnet-5-5` is not enabled'],
    ])(
      'warns on %i with the Model Garden page as the fix, and still passes',
      async (code, message) => {
        const report = await setup(
          {},
          REQUIRED_GCP_PERMISSIONS,
          undefined,
          code,
          undefined,
          message,
        ).run();
        expect(status(report, 'vertex-model')).toMatchObject({
          status: 'warn',
          title: expect.stringContaining(
            `Claude ${MODEL} is not enabled for your Google Cloud project`,
          ) as unknown,
          fix: GARDEN,
        });
        expect(report.passed).toBe(true);
      },
    );

    it('warns, naming the cause, when the deployer lacks aiplatform.endpoints.predict', async () => {
      const report = await setup(
        {},
        REQUIRED_GCP_PERMISSIONS,
        undefined,
        403,
        undefined,
        "Permission 'aiplatform.endpoints.predict' denied on resource",
        'PERMISSION_DENIED',
      ).run();
      expect(status(report, 'vertex-model')?.status).toBe('warn');
      expect(status(report, 'vertex-model')?.title).toContain('aiplatform.endpoints.predict');
      expect(report.passed).toBe(true);
    });

    it('warns to retry in a minute when the API was only just enabled', async () => {
      const report = await setup(
        {},
        REQUIRED_GCP_PERMISSIONS,
        undefined,
        403,
        undefined,
        'Vertex AI API has not been used in project 1 before or it is disabled.',
        'PERMISSION_DENIED',
      ).run();
      expect(status(report, 'vertex-model')?.status).toBe('warn');
      expect(status(report, 'vertex-model')?.title).toContain('again in a minute');
      expect(report.passed).toBe(true);
    });

    it('warns on 429 with the quotas page, and still passes', async () => {
      const report = await setup({}, REQUIRED_GCP_PERMISSIONS, undefined, 429, 'eu').run();
      const entry = status(report, 'vertex-model');
      expect(entry?.status).toBe('warn');
      expect(entry?.title).toBe('The quota for Claude in eu is exhausted');
      expect(entry?.fix).toContain(
        `https://console.cloud.google.com/iam-admin/quotas?project=${PROJECT}`,
      );
      expect(entry?.fix).toContain('anthropic-claude-sonnet');
      expect(report.passed).toBe(true);
    });

    it.each([500, 400])('warns that it could not check on %i', async (code) => {
      const report = await setup({}, REQUIRED_GCP_PERMISSIONS, undefined, code).run();
      expect(status(report, 'vertex-model')?.status).toBe('warn');
      expect(status(report, 'vertex-model')?.title).toContain('Could not check');
      expect(report.passed).toBe(true);
    });

    it('warns that it could not check on a network error, without the error text', async () => {
      const report = await setup(
        {},
        REQUIRED_GCP_PERMISSIONS,
        undefined,
        new Error(`connect ECONNREFUSED ${TOKEN}`),
      ).run();
      expect(status(report, 'vertex-model')?.status).toBe('warn');
      expect(JSON.stringify(report)).not.toContain('ECONNREFUSED');
    });

    it('waits for the API when it is not enabled and sends nothing', async () => {
      const key = `gcloud services list --enabled --project ${PROJECT} --format=value(config.name)`;
      const { run, requests } = setup({ [key]: ok('run.googleapis.com\n') });
      const report = await run();
      expect(requests.some(({ url }) => url.includes('rawPredict'))).toBe(false);
      expect(status(report, 'vertex-model')).toMatchObject({
        status: 'warn',
        title: 'Claude is checked once the Vertex AI API is enabled',
      });
    });

    it('checks after the API was enabled by --yes', async () => {
      const key = `gcloud services list --enabled --project ${PROJECT} --format=value(config.name)`;
      const enable = `gcloud services enable ${REQUIRED_GCP_APIS.slice(1).join(' ')} --project ${PROJECT}`;
      const { run, requests } = setup({ [key]: ok('run.googleapis.com\n'), [enable]: ok() });
      const report = await run(true);
      expect(requests.some(({ url }) => url.includes('rawPredict'))).toBe(true);
      expect(status(report, 'vertex-model')?.status).toBe('ok');
    });

    it('never puts the token in the report', async () => {
      const report = await setup({}, REQUIRED_GCP_PERMISSIONS, undefined, 403).run();
      expect(JSON.stringify(report) + renderPreflightReport(report)).not.toContain(TOKEN);
    });
  });

  it('never prints the token', async () => {
    const { run, out, err } = setup({ 'docker buildx version': failed });
    const report = await run();
    const printed = [...out, ...err, renderPreflightReport(report), JSON.stringify(report)].join(
      '',
    );
    expect(printed).not.toContain(TOKEN);
    expect(printed).toContain('$ gcloud auth application-default print-access-token');
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
    const key = `gcloud services list --enabled --project ${PROJECT} --format=value(config.name)`;
    const report = await setup({
      'gcloud auth application-default print-access-token': failed,
      'gcloud auth print-access-token': failed,
      [key]: ok('run.googleapis.com\n'),
      'terraform version -json': missingTool,
      [policyKey('run.allowedIngress')]: ok(
        JSON.stringify({ spec: { rules: [{ enforce: true }] } }),
      ),
      [policyKey('run.allowedVPCEgress')]: ok(
        JSON.stringify({ spec: { rules: [{ enforce: true }] } }),
      ),
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
