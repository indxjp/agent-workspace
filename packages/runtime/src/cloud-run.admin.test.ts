import { describe, expect, it, vi } from 'vitest';

import { NET } from './cloud-run.test-support.js';

describe('createCloudRunAdminClient', () => {
  it('sends a bearer token and rejects a non-2xx create response', async () => {
    const { createCloudRunAdminClient } = await import('./cloud-run.js');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const doFetch = vi.fn<typeof fetch>((url, init = {}) => {
      const href = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
      calls.push({ url: href, init });
      return Promise.resolve(new Response('forbidden', { status: 403 }));
    });
    const client = createCloudRunAdminClient({
      fetch: doFetch,
      accessToken: () => Promise.resolve('tok'),
    });
    await expect(
      client.createService({
        serviceId: 'rt-1',
        image: 'runtime@sha256:abc',
        region: 'asia-northeast1',
        project: 'proj',
        serviceAccount: 'sa@proj.iam.gserviceaccount.com',
        ...NET,
        labels: {},
      }),
    ).rejects.toThrow(/create service rt-1 failed: 403/u);
    expect(calls[0]?.url).toContain(
      'projects/proj/locations/asia-northeast1/services?serviceId=rt-1',
    );
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
  });
});

describe('createCloudRunAdminClient sandbox placement', () => {
  it('puts every sandbox on the firewalled network, internal-only, with a /ping startup probe', async () => {
    const { createCloudRunAdminClient } = await import('./cloud-run.js');
    const bodies: unknown[] = [];
    const client = createCloudRunAdminClient({
      fetch: (_url, init = {}) => {
        bodies.push(JSON.parse(typeof init.body === 'string' ? init.body : '{}'));
        return Promise.resolve(new Response(JSON.stringify({ name: 'op' }), { status: 200 }));
      },
      accessToken: () => Promise.resolve('tok'),
    });
    await client.createService({
      serviceId: 'rt-1',
      image: 'runtime@sha256:abc',
      region: 'asia-northeast1',
      project: 'proj',
      serviceAccount: 'sa@proj.iam.gserviceaccount.com',
      ...NET,
      labels: {},
    });
    const body = bodies[0] as {
      ingress: string;
      template: { vpcAccess: Record<string, unknown>; containers: Array<Record<string, unknown>> };
    };
    expect(body.ingress).toBe('INGRESS_TRAFFIC_INTERNAL_ONLY');
    expect(body.template.vpcAccess).toEqual({
      networkInterfaces: [{ ...NET, tags: ['aw-sandbox'] }],
      egress: 'ALL_TRAFFIC',
    });
    expect(body.template.vpcAccess).not.toHaveProperty('connector');
    expect(body.template.containers[0]?.['startupProbe']).toEqual({
      httpGet: { path: '/ping', port: 8080 },
      periodSeconds: 2,
      failureThreshold: 50,
      timeoutSeconds: 1,
    });
  });
});
