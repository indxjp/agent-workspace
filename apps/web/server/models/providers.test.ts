import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';
import { describe, expect, it } from 'vitest';

import { PROVIDER_CONNECTION_FACTS } from './providers';

describe('PROVIDER_CONNECTION_FACTS', () => {
  it('has a row for every model provider', () => {
    expect(Object.keys(PROVIDER_CONNECTION_FACTS).sort()).toEqual([...MODEL_PROVIDERS].sort());
  });

  it('withholds prompt caching from anthropic-compatible connections only', () => {
    const withheld = MODEL_PROVIDERS.filter(
      (provider) => !PROVIDER_CONNECTION_FACTS[provider].mayClaimPromptCaching,
    );
    expect(withheld).toEqual(['anthropic-compatible']);
  });
});
