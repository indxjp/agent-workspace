import { describe, expect, it } from 'vitest';

import type { CloudRunResourceClient } from './cloud-run.js';
import { cloudRunDriver, cloudRunToolDriver, fakeClient } from './cloud-run.test-support.js';

const KEY = 'aw-egress-test-key-0123456789abcdef';
const GATEWAY = '10.10.0.50';
const MIRROR = `http://${GATEWAY}`;
const PROXY = { url: 'http://10.10.0.60:3128', key: KEY, bypass: [GATEWAY] };

function createWith(
  client: CloudRunResourceClient,
  networkPolicy: 'none' | 'restricted',
  overrides: Parameters<typeof cloudRunDriver>[1],
) {
  return cloudRunDriver(client, overrides).create({
    sessionId: 'sess-1',
    engine: 'claude-agent-sdk',
    workspacePath: '/ws/s',
    runSpec: {
      runtimeProfileId: 'demo-sandbox',
      driver: 'cloud-run-service',
      networkPolicy,
      filesystem: 'read-write',
      ...(networkPolicy === 'restricted' ? { allowedDomains: ['api.example.com'] } : {}),
    },
  });
}

describe('cloud-run-service runtime: the control-plane link (AW_SESSION_MIRROR_URL, ADR-0172)', () => {
  it('gives a none sandbox the mirror URL and no proxy, so it reaches the control plane and nothing else', async () => {
    const { client, specs } = fakeClient();
    await createWith(client, 'none', { sessionMirrorUrl: `${MIRROR}/` });
    expect(specs[0]?.env).toEqual({ AW_SESSION_MIRROR_URL: MIRROR });
  });

  it('gives the mirror URL even without a run spec', async () => {
    const { client, specs } = fakeClient();
    await cloudRunDriver(client, { sessionMirrorUrl: MIRROR }).create({
      sessionId: 'sess-2',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
    });
    expect(specs[0]?.env).toEqual({ AW_SESSION_MIRROR_URL: MIRROR });
  });

  it('keeps a proxied sandbox on a direct route to the mirror, which the proxy never sees', async () => {
    const { client, specs } = fakeClient();
    await createWith(client, 'restricted', { sessionMirrorUrl: MIRROR, egressProxy: PROXY });
    const env = specs[0]?.env;
    expect(env?.['AW_SESSION_MIRROR_URL']).toBe(MIRROR);
    expect(env?.['NO_PROXY']?.split(',')).toContain(GATEWAY);
  });

  it('sets nothing when no mirror is configured, as before', async () => {
    const { client, specs } = fakeClient();
    await createWith(client, 'none', {});
    expect(specs[0]?.env).toBeUndefined();
  });

  it('keeps the tool host intake variables beside the mirror URL', async () => {
    const { client, specs } = fakeClient();
    await cloudRunToolDriver(client, {
      sessionMirrorUrl: MIRROR,
      fileIntake: { identityToken: () => Promise.resolve('id-token') },
    }).create({ sessionId: 'sess-3', engine: 'claude-agent-sdk', workspacePath: '/ws/s' });
    expect(specs[0]?.env).toMatchObject({
      AW_SESSION_MIRROR_URL: MIRROR,
      TOOL_HOST_DIR: '/tmp/tool-host',
    });
    expect(specs[0]?.env?.['AW_TOOL_INTAKE_KEY']).toMatch(/^[\w-]{43}$/u);
  });

  it.each([
    ['not a url'],
    ['ftp://10.10.0.50'],
    ['http://user:pass@10.10.0.50'],
    ['http://10.10.0.50/?x=1'],
    ['http://10.10.0.50/#frag'],
    ['http://10.10.0.50/base'],
    ['http://10.10.0.50/api/'],
    ['   '],
  ])('refuses the mirror URL %j', (sessionMirrorUrl) => {
    expect(() => cloudRunDriver(fakeClient().client, { sessionMirrorUrl })).toThrow(
      /sessionMirrorUrl/u,
    );
  });

  it('refuses a mirror host the egress proxy would carry, naming the bypass list', () => {
    expect(() =>
      cloudRunDriver(fakeClient().client, {
        sessionMirrorUrl: 'http://web.internal.example',
        egressProxy: PROXY,
      }),
    ).toThrow(/web\.internal\.example must be in the egress proxy bypass list/u);
  });
});
