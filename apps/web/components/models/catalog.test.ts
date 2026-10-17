import { describe, expect, it } from 'vitest';

import {
  describeInheritance,
  findCatalogEntry,
  formatResolvedModel,
  readCatalog,
  sameSelection,
  type CatalogModel,
} from './catalog';

const CONNECTIONS_BODY = {
  models: [
    {
      id: 'c-anthropic',
      name: 'Prod Anthropic',
      provider: 'anthropic',
      config: {},
      hasCredential: true,
      ready: true,
    },
    {
      id: 'c-azure',
      name: 'Azure GPT',
      provider: 'azure-openai',
      config: {
        baseUrl: 'https://x.openai.azure.com',
        deployment: 'gpt-41',
        apiVersion: '2024-06-01',
      },
      hasCredential: true,
      ready: true,
    },
    {
      id: 'c-no-cred',
      name: 'Unconfigured OpenAI',
      provider: 'openai',
      config: {},
      hasCredential: false,
      ready: false,
    },
  ],
};

function discovery(rows: unknown[], unavailable: unknown[] = []) {
  return { models: rows, ...(unavailable.length > 0 ? { unavailable } : {}) };
}

const CAPS = {
  streaming: true,
  toolUse: true,
  thinking: true,
  promptCaching: true,
  structuredOutput: true,
  contextManagement: true,
  webSearch: true,
  tokenCounting: true,
};

describe('readCatalog', () => {
  it('joins a discovered row onto the connection that offers it, by id — never by label', () => {
    const catalog = readCatalog(
      discovery([
        {
          connectionId: 'c-anthropic',
          providerModelId: 'claude-sonnet-4-5',
          displayName: 'Claude Sonnet 4.5',
          capabilities: CAPS,
        },
      ]),
      CONNECTIONS_BODY,
    );
    expect(catalog.models).toEqual([
      {
        connectionId: 'c-anthropic',
        connectionName: 'Prod Anthropic',
        provider: 'anthropic',
        providerModelId: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
        capabilities: CAPS,
      },
    ]);
  });

  it('carries a real, non-null provider-side model id for a non-Azure connection', () => {
    // #130's own regression: the old code read `config.deployment` as "the model", which only
    // Azure ever populates, so every Anthropic/OpenAI selection persisted `model: null`.
    const catalog = readCatalog(
      discovery([
        {
          connectionId: 'c-anthropic',
          providerModelId: 'claude-opus-4-1',
          displayName: 'Claude Opus 4.1',
          capabilities: CAPS,
        },
      ]),
      CONNECTIONS_BODY,
    );
    expect(catalog.models[0]?.providerModelId).toBe('claude-opus-4-1');
    expect(catalog.models[0]?.providerModelId).not.toBeNull();
  });

  it('drops a discovered row whose connection id the connections response no longer carries', () => {
    const catalog = readCatalog(
      discovery([
        {
          connectionId: 'deleted-connection',
          providerModelId: 'whatever',
          displayName: 'Whatever',
          capabilities: CAPS,
        },
      ]),
      CONNECTIONS_BODY,
    );
    expect(catalog.models).toEqual([]);
  });

  it('names a connection discovery itself failed on, with the reason the server gave', () => {
    const catalog = readCatalog(
      discovery(
        [],
        [{ connectionId: 'c-azure', connectionName: 'Azure GPT', reason: 'timed out' }],
      ),
      CONNECTIONS_BODY,
    );
    expect(catalog.unavailable).toContainEqual({
      connectionId: 'c-azure',
      connectionName: 'Azure GPT',
      reason: 'timed out',
    });
  });

  it('names an un-ready (no credential) connection as unavailable without a discovery attempt', () => {
    const catalog = readCatalog(discovery([]), CONNECTIONS_BODY);
    const entry = catalog.unavailable.find((row) => row.connectionId === 'c-no-cred');
    expect(entry?.reason).toBe('Credential missing');
  });

  it('never lists the same connection twice in unavailable', () => {
    const catalog = readCatalog(
      discovery(
        [],
        [
          {
            connectionId: 'c-no-cred',
            connectionName: 'Unconfigured OpenAI',
            reason: 'no credential',
          },
        ],
      ),
      CONNECTIONS_BODY,
    );
    const matches = catalog.unavailable.filter((row) => row.connectionId === 'c-no-cred');
    expect(matches).toHaveLength(1);
  });
});

describe('sameSelection', () => {
  it('treats two nulls as equal and a null against a value as unequal', () => {
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(null, { connectionId: 'a', model: 'm' })).toBe(false);
  });
  it('compares both the connection and the model', () => {
    expect(
      sameSelection({ connectionId: 'a', model: 'm' }, { connectionId: 'a', model: 'm' }),
    ).toBe(true);
    expect(
      sameSelection({ connectionId: 'a', model: 'm' }, { connectionId: 'a', model: 'n' }),
    ).toBe(false);
    expect(
      sameSelection({ connectionId: 'a', model: 'm' }, { connectionId: 'b', model: 'm' }),
    ).toBe(false);
  });
});

const ENTRY: CatalogModel = {
  connectionId: 'c1',
  connectionName: 'Prod Anthropic',
  provider: 'anthropic',
  providerModelId: 'claude-sonnet-4-5',
  displayName: 'claude-sonnet-4-5',
  capabilities: CAPS,
};

describe('formatResolvedModel / describeInheritance', () => {
  it('formats as "Provider / model", the card\'s own example shape', () => {
    expect(formatResolvedModel(ENTRY)).toBe('Anthropic / claude-sonnet-4-5');
  });

  it('names the source and the resolved pair on one line', () => {
    expect(
      describeInheritance('Project default', { connectionId: 'c1', model: 'claude-sonnet-4-5' }, [
        ENTRY,
      ]),
    ).toBe('Project default → Anthropic / claude-sonnet-4-5');
  });

  it('says "not set" for a null selection rather than going blank', () => {
    expect(describeInheritance('Workspace default', null, [ENTRY])).toBe(
      'Workspace default → not set',
    );
  });

  it('names a selection whose connection the catalog no longer carries as stale, not silently', () => {
    const line = describeInheritance('Agent override', { connectionId: 'gone', model: 'x' }, [
      ENTRY,
    ]);
    expect(line).toContain('Agent override →');
    expect(line).toContain('gone');
    expect(line).toContain('no longer available');
  });
});

describe('findCatalogEntry', () => {
  it('finds by the (connectionId, model) pair, not by either alone', () => {
    expect(findCatalogEntry([ENTRY], { connectionId: 'c1', model: 'claude-sonnet-4-5' })).toBe(
      ENTRY,
    );
    expect(findCatalogEntry([ENTRY], { connectionId: 'c1', model: 'other-model' })).toBeUndefined();
    expect(findCatalogEntry([ENTRY], null)).toBeUndefined();
  });
});
