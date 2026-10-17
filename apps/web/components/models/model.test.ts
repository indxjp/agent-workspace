import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';
import { describe, expect, it } from 'vitest';

import {
  PROVIDER_CHOICES,
  agentsReferencing,
  confirmationMatches,
  connectionStatus,
  editableConfigFields,
  formatApiError,
  isEditFormValid,
  providerLabel,
  readAgentSummaries,
  readModelConnections,
  requiredConfigFields,
  updateConnectionPayload,
  type EditFormValues,
} from './model';

describe('PROVIDER_CHOICES', () => {
  it('offers every schema-supported provider, including anthropic-compatible', () => {
    const ids = PROVIDER_CHOICES.map((choice) => choice.id);
    expect([...ids].sort()).toEqual([...MODEL_PROVIDERS].sort());
  });

  it('lists the providers in display order', () => {
    const ids = PROVIDER_CHOICES.map((choice) => choice.id);
    expect(ids).toEqual([
      'anthropic',
      'anthropic-compatible',
      'azure-openai',
      'openai',
      'openai-compatible',
    ]);
  });

  it('parses a connection of the newly-offered provider the same as any other', () => {
    const [connection] = readModelConnections({
      models: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Internal Claude gateway',
          provider: 'anthropic-compatible',
          config: {},
          hasCredential: true,
          ready: true,
        },
      ],
    });
    expect(connection?.provider).toBe('anthropic-compatible');
    expect(providerLabel('anthropic-compatible')).toBe('Anthropic-compatible endpoint');
  });
});

describe('connectionStatus', () => {
  it('reports a missing credential before it reports incomplete configuration', () => {
    expect(connectionStatus({ hasCredential: false, ready: false })).toEqual({
      text: 'Credential missing',
      tone: 'danger',
    });
  });

  it('reports incomplete configuration when the credential exists but readiness does not', () => {
    expect(connectionStatus({ hasCredential: true, ready: false })).toEqual({
      text: 'Configuration incomplete',
      tone: 'warn',
    });
  });

  it('reports ready only when the server says both are true', () => {
    expect(connectionStatus({ hasCredential: true, ready: true })).toEqual({
      text: 'Ready',
      tone: 'ok',
    });
  });
});

describe('requiredConfigFields / editableConfigFields — the field set §126 validates, transcribed', () => {
  it('requires nothing extra for anthropic, anthropic-compatible or openai', () => {
    for (const provider of ['anthropic', 'anthropic-compatible', 'openai'] as const) {
      expect(requiredConfigFields(provider)).toEqual([]);
      expect(editableConfigFields(provider)).toEqual(['baseUrl']);
    }
  });

  it('requires baseUrl for openai-compatible', () => {
    expect(requiredConfigFields('openai-compatible')).toEqual(['baseUrl']);
  });

  it('requires baseUrl, deployment and apiVersion for azure-openai, and offers all three fields', () => {
    expect(requiredConfigFields('azure-openai')).toEqual(['baseUrl', 'deployment', 'apiVersion']);
    expect(editableConfigFields('azure-openai')).toEqual(['baseUrl', 'deployment', 'apiVersion']);
  });
});

const EMPTY: EditFormValues = { name: 'Prod Claude', baseUrl: '', deployment: '', apiVersion: '' };

describe('isEditFormValid', () => {
  it('rejects a blank name regardless of provider', () => {
    expect(isEditFormValid({ ...EMPTY, name: '  ' }, 'anthropic')).toBe(false);
  });

  it('accepts anthropic with no config at all', () => {
    expect(isEditFormValid(EMPTY, 'anthropic')).toBe(true);
  });

  it('rejects azure-openai until every required field is filled, then accepts it', () => {
    expect(isEditFormValid(EMPTY, 'azure-openai')).toBe(false);
    expect(
      isEditFormValid({ ...EMPTY, baseUrl: 'https://x', deployment: 'd' }, 'azure-openai'),
    ).toBe(false);
    expect(
      isEditFormValid(
        { ...EMPTY, baseUrl: 'https://x', deployment: 'd', apiVersion: '2024-01-01' },
        'azure-openai',
      ),
    ).toBe(true);
  });
});

describe('updateConnectionPayload', () => {
  it('omits config fields the provider does not allow and blank ones it does', () => {
    expect(updateConnectionPayload(EMPTY, 'anthropic')).toEqual({
      name: 'Prod Claude',
      config: {},
    });
  });

  it('carries only the trimmed fields azure-openai allows', () => {
    expect(
      updateConnectionPayload(
        {
          name: ' Prod Azure ',
          baseUrl: ' https://x ',
          deployment: ' d ',
          apiVersion: ' 2024-01-01 ',
        },
        'azure-openai',
      ),
    ).toEqual({
      name: 'Prod Azure',
      config: { baseUrl: 'https://x', deployment: 'd', apiVersion: '2024-01-01' },
    });
  });
});

describe('formatApiError', () => {
  it('joins the message with field-level details when both are present', () => {
    expect(
      formatApiError({
        error: {
          code: 'invalid_body',
          message: 'The connection could not be updated.',
          details: ['config.baseUrl is required.'],
        },
      }),
    ).toBe('The connection could not be updated. config.baseUrl is required.');
  });

  it('falls back to a generic sentence for an unrecognised body', () => {
    expect(formatApiError(null)).toBe('The request failed.');
    expect(formatApiError({})).toBe('The request failed.');
  });
});

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

describe("readAgentSummaries / agentsReferencing — the remove flow's preview", () => {
  it('finds only the agents that reference this connection, skipping malformed entries', () => {
    const agents = readAgentSummaries({
      agents: [
        { id: 'a1', name: 'Support Agent', modelConnectionId: CONNECTION_ID },
        { id: 'a2', name: 'Other Agent', modelConnectionId: 'some-other-connection' },
        { id: 'a3', name: 'Default Agent', modelConnectionId: null },
        { id: 'a4' /* no name: skipped */ },
      ],
    });
    expect(agentsReferencing(agents, CONNECTION_ID)).toEqual([
      { agentId: 'a1', agentName: 'Support Agent' },
    ]);
  });

  it('reports no agents when the response has none referencing this connection', () => {
    const agents = readAgentSummaries({
      agents: [{ id: 'a2', name: 'Other Agent', modelConnectionId: null }],
    });
    expect(agentsReferencing(agents, CONNECTION_ID)).toEqual([]);
  });

  it('parses an unrecognisable body as no agents, rather than throwing', () => {
    expect(readAgentSummaries(null)).toEqual([]);
    expect(readAgentSummaries({})).toEqual([]);
  });
});

describe("confirmationMatches — the remove flow's gate", () => {
  it('requires an exact, case-sensitive match of the connection name', () => {
    expect(confirmationMatches('Prod Claude', 'Prod Claude')).toBe(true);
    expect(confirmationMatches('prod claude', 'Prod Claude')).toBe(false);
    expect(confirmationMatches('Prod Claud', 'Prod Claude')).toBe(false);
    expect(confirmationMatches('', 'Prod Claude')).toBe(false);
    // Typing the *agent's* name instead of the connection's must not satisfy the gate.
    expect(confirmationMatches('Support Agent', 'Prod Claude')).toBe(false);
  });
});
