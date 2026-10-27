import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_AUTH_TYPES,
  CONNECTOR_TRANSPORTS,
  CREDENTIALED_CONNECTOR_AUTH_TYPES,
  REMOTE_CONNECTOR_TRANSPORTS,
} from './connectors.js';
import { MODEL_PROVIDERS } from './runs.js';
import { SETUP_PROVIDERS } from './setup.js';

describe('catalogue subsets', () => {
  it('REMOTE_CONNECTOR_TRANSPORTS is CONNECTOR_TRANSPORTS without stdio', () => {
    expect([...REMOTE_CONNECTOR_TRANSPORTS]).toEqual(
      CONNECTOR_TRANSPORTS.filter((transport) => transport !== 'stdio'),
    );
  });

  it('CREDENTIALED_CONNECTOR_AUTH_TYPES is CONNECTOR_AUTH_TYPES without none', () => {
    expect([...CREDENTIALED_CONNECTOR_AUTH_TYPES]).toEqual(
      CONNECTOR_AUTH_TYPES.filter((authType) => authType !== 'none'),
    );
  });

  it('SETUP_PROVIDERS is MODEL_PROVIDERS without anthropic-compatible', () => {
    expect([...SETUP_PROVIDERS].sort()).toEqual(
      MODEL_PROVIDERS.filter((provider) => provider !== 'anthropic-compatible').sort(),
    );
  });
});
