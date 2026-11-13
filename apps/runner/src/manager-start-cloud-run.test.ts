import { expect, it } from 'vitest';
import { cloudRunSandboxOrigin, cloudRunToolSandboxOrigin } from './manager-driver-cloud-run.js';
import { managerDriverOptions } from './manager-start.js';

const cloudRun = {
  RUNTIME_DRIVER: 'cloud-run-service',
  GCP_PROJECT: 'proj',
  GCP_REGION: 'asia-northeast1',
  RUNTIME_SERVICE_ACCOUNT: 'sa@proj.iam.gserviceaccount.com',
  AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: `r@sha256:${'a'.repeat(64)}`,
  RUNTIME_NETWORK: 'aw-net',
  RUNTIME_SUBNETWORK: 'aw-sandbox-subnet',
};

const TOOL_IMAGE = `tool-host@sha256:${'b'.repeat(64)}`;

const KEY = 'aw-egress-test-key-0123456789abcdef';

const proxy = {
  RUNTIME_EGRESS_PROXY_URL: 'http://10.10.0.60:3128',
  RUNTIME_EGRESS_PROXY_KEY: KEY,
};

it('runner manager cloud-run-service network > serves cloud-run-service and fingerprints the network and subnetwork', () => {
  const options = managerDriverOptions(cloudRun);
  expect(options.expectedDriver).toBe('cloud-run-service');
  expect(options.configurationFingerprint).toContain(':aw-net:aw-sandbox-subnet');
});

it.each(['RUNTIME_NETWORK', 'RUNTIME_SUBNETWORK'])(
  'runner manager cloud-run-service network > refuses a missing %s',
  (name) => {
    expect(() => managerDriverOptions({ ...cloudRun, [name]: '  ' })).toThrow(name);
    expect(() => managerDriverOptions({ ...cloudRun, [name]: undefined })).toThrow(name);
  },
);

it.each(['RUNTIME_VPC_CONNECTOR', 'RUNTIME_EGRESS'])(
  'runner manager cloud-run-service network > refuses the legacy %s',
  (name) => {
    expect(() => managerDriverOptions({ ...cloudRun, [name]: 'open' })).toThrow(
      new RegExp(`${name} is no longer supported`, 'u'),
    );
  },
);

it('runner manager cloud-run-service network > points the legacy RUNTIME_EGRESS user at the proxy variables, not a later release', () => {
  const attempt = () => managerDriverOptions({ ...cloudRun, RUNTIME_EGRESS: 'open' });
  expect(attempt).toThrow(/RUNTIME_EGRESS_PROXY_URL/u);
  expect(attempt).not.toThrow(/later release/u);
});

it('runner manager cloud-run-service network > tool sandboxes (AGENT_WORKSPACE_TOOL_HOST_IMAGE) > has toolSandboxes and fingerprints the tool image', () => {
  const options = managerDriverOptions({
    ...cloudRun,
    AGENT_WORKSPACE_TOOL_HOST_IMAGE: TOOL_IMAGE,
  });
  expect(options.toolSandboxes).toBeDefined();
  expect(options.toolSandboxRefusal).toBeUndefined();
  expect(options.configurationFingerprint).toContain(`+tools=${TOOL_IMAGE}`);
});

it('runner manager cloud-run-service network > tool sandboxes (AGENT_WORKSPACE_TOOL_HOST_IMAGE) > names the variable to set when there is no tool image', () => {
  const options = managerDriverOptions(cloudRun);
  expect(options.toolSandboxes).toBeUndefined();
  expect(options.toolSandboxRefusal).toBe(
    'a tool sandbox is not started on cloud-run-service: set AGENT_WORKSPACE_TOOL_HOST_IMAGE to the tool-host image',
  );
  expect(options.configurationFingerprint).not.toContain('+tools=');
});

it('runner manager cloud-run-service network > tool sandboxes (AGENT_WORKSPACE_TOOL_HOST_IMAGE) > accepts the tool image together with the egress proxy', () => {
  const options = managerDriverOptions({
    ...cloudRun,
    AGENT_WORKSPACE_TOOL_HOST_IMAGE: TOOL_IMAGE,
    RUNTIME_EGRESS_PROXY_URL: 'http://10.10.0.60:3128',
    RUNTIME_EGRESS_PROXY_KEY: 'aw-egress-test-key-0123456789abcdef',
  });
  expect(options.toolSandboxes).toBeDefined();
});

it('runner manager cloud-run-service network > sandbox internet (RUNTIME_EGRESS_PROXY_URL) > claims allowlist and open when both variables are set', () => {
  const options = managerDriverOptions({
    ...cloudRun,
    ...proxy,
    RUNTIME_PROXY_BYPASS: '10.10.0.10',
  });
  expect(options.driver.capabilities?.networkPolicies).toEqual(['none', 'allowlist', 'open']);
});

it('runner manager cloud-run-service network > sandbox internet (RUNTIME_EGRESS_PROXY_URL) > stays at none without them', () => {
  expect(managerDriverOptions(cloudRun).driver.capabilities?.networkPolicies).toEqual(['none']);
});

it('runner manager cloud-run-service network > sandbox internet (RUNTIME_EGRESS_PROXY_URL) > refuses a URL without a key and a key without a URL, naming both', () => {
  expect(() =>
    managerDriverOptions({
      ...cloudRun,
      RUNTIME_EGRESS_PROXY_URL: proxy.RUNTIME_EGRESS_PROXY_URL,
    }),
  ).toThrow(/RUNTIME_EGRESS_PROXY_URL and RUNTIME_EGRESS_PROXY_KEY/u);
  expect(() => managerDriverOptions({ ...cloudRun, RUNTIME_EGRESS_PROXY_KEY: KEY })).toThrow(
    /RUNTIME_EGRESS_PROXY_URL and RUNTIME_EGRESS_PROXY_KEY/u,
  );
});

it('runner manager cloud-run-service network > sandbox internet (RUNTIME_EGRESS_PROXY_URL) > fingerprints the proxy URL and never the key', () => {
  const fingerprint = managerDriverOptions({ ...cloudRun, ...proxy }).configurationFingerprint;
  expect(fingerprint).toContain('+proxy=http://10.10.0.60:3128');
  expect(fingerprint).not.toContain(KEY);
});

it('runner manager cloud-run-service network > tool sandboxes (AGENT_WORKSPACE_TOOL_HOST_IMAGE) > hands the gateway only an https rt-tool- run.app origin, the host its invoke grant matches', () => {
  expect(cloudRunToolSandboxOrigin('https://rt-tool-abc-x7k2m9p4qa-an.a.run.app')).toBe(
    'https://rt-tool-abc-x7k2m9p4qa-an.a.run.app',
  );
  expect(
    cloudRunToolSandboxOrigin('https://rt-tool-abc-123456789012.asia-northeast1.run.app/'),
  ).toBe('https://rt-tool-abc-123456789012.asia-northeast1.run.app');
  for (const url of [
    'https://rt-0f3c2b1a-x7k2m9p4qa-an.a.run.app',
    'http://rt-tool-abc-x7k2m9p4qa-an.a.run.app',
    'https://rt-tool-abc.example.com',
    'https://rt-tool-abc.run.app.example.com',
    'not a url',
  ]) {
    expect(() => cloudRunToolSandboxOrigin(url), url).toThrow(/request\.host/u);
  }
});

it('runner manager cloud-run-service network > calls an agent sandbox only at an https rt- run.app origin, the host its own invoke grant matches', () => {
  expect(cloudRunSandboxOrigin('https://rt-0f3c2b1a-x7k2m9p4qa-an.a.run.app')).toBe(
    'https://rt-0f3c2b1a-x7k2m9p4qa-an.a.run.app',
  );
  expect(cloudRunSandboxOrigin('https://rt-0f3c2b1a-123456789012.asia-northeast1.run.app/')).toBe(
    'https://rt-0f3c2b1a-123456789012.asia-northeast1.run.app',
  );
  for (const url of [
    'https://agent-workspace-web-x7k2m9p4qa-an.a.run.app',
    'http://rt-0f3c2b1a-x7k2m9p4qa-an.a.run.app',
    'https://rt-0f3c2b1a.example.com',
    'https://rt-0f3c2b1a.run.app.example.com',
    'not a url',
  ]) {
    expect(() => cloudRunSandboxOrigin(url), url).toThrow(/request\.host/u);
  }
  const { runtimeOrigin } = managerDriverOptions(cloudRun);
  const handle = {
    id: '0f3c2b1a',
    driver: 'cloud-run-service' as const,
    workspacePath: '/workspace',
    createdAt: new Date(0),
  };
  expect(
    runtimeOrigin?.({ ...handle, externalId: 'https://rt-0f3c2b1a-x7k2m9p4qa-an.a.run.app' }),
  ).toBe('https://rt-0f3c2b1a-x7k2m9p4qa-an.a.run.app');
  expect(() =>
    runtimeOrigin?.({
      ...handle,
      externalId: 'https://agent-workspace-gateway-x7k2m9p4qa-an.a.run.app',
    }),
  ).toThrow(/request\.host/u);
});
