import { describe, expect, it, vi } from 'vitest';

// F-22 / W3-8: `@azure/identity` is loaded only when the aca-sessions driver asks for a token, so a
// process that selects any other driver — or only imports the driver contract — never pays for it.
const azure = vi.hoisted(() => ({ loaded: false }));

vi.mock('@azure/identity', () => {
  azure.loaded = true;
  return {
    DefaultAzureCredential: class {
      public getToken(): Promise<{ token: string }> {
        return Promise.resolve({ token: 'lazy-token' });
      }
    },
  };
});

// Each import below is the module behind one `@agent-workspace/runtime/driver…` subpath.
describe('@azure/identity is loaded lazily', () => {
  it('is not loaded by importing every driver subpath, and is loaded by the first token request', async () => {
    await import('./index.js');
    await import('./local.js');
    await import('./docker.js');
    await import('./kubernetes.js');
    await import('./cloud-run.js');
    await import('./external/index.js');
    await import('./vercel-sandbox.js');
    await import('./cloudflare-sandbox.js');
    const aca = await import('./aca-sessions.js');
    expect(azure.loaded).toBe(false);

    await expect(aca.fetchAcaSessionsAccessToken()).resolves.toBe('lazy-token');
    expect(azure.loaded).toBe(true);
  });
});
