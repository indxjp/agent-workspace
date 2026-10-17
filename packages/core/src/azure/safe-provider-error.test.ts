import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import { azureProviderCall } from './safe-provider-error.js';

describe('Azure provider error sanitisation', () => {
  it('retains status classification without retaining request credentials', async () => {
    const token = 'Bearer provider-token-that-must-not-reach-logs';
    const providerError = Object.assign(new Error(`request failed with ${token}`), {
      statusCode: 403,
      request: { headers: { authorization: token } },
    });
    let caught: unknown;
    try {
      await azureProviderCall('blob', 'read', () => Promise.reject(providerError));
    } catch (error) {
      caught = error;
    }

    const diagnostic = inspect(caught, { depth: 10 });
    expect(diagnostic).toContain('Azure service returned HTTP 403.');
    expect(diagnostic).not.toContain(token);
    expect(diagnostic).not.toContain('authorization');
  });
});
