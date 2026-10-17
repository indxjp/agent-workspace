import { describe, expect, it } from 'vitest';

import { credentialRejectedError, isGatewayTokenRefusal } from './credential-rejection.js';

describe('credential rejection', () => {
  it('names the status and nothing else', () => {
    expect(credentialRejectedError(401).message).toBe(
      'model_credential_rejected: the model provider rejected the API key (HTTP 401).',
    );
  });

  it('recognises a gateway token_* refusal only', () => {
    expect(isGatewayTokenRefusal('{"error":{"code":"token_expired"}}')).toBe(true);
    expect(isGatewayTokenRefusal('{"error":{"code":"invalid_api_key"}}')).toBe(false);
  });
});
