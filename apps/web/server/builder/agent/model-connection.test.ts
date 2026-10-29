import { describe, expect, it } from 'vitest';

import type { DefinitionReferences, ResolveDefinitionOutcome } from '../../agent-versions/store';
import { setupConnectionName } from '../../setup/runtime';
import { resolveBuilderDefinition } from './model-connection';

const SETUP_ID = 'connection-of-setup';
const DEFAULT_ID = 'connection-named-default';

const REFERENCES: DefinitionReferences = {
  modelConnectionName: 'default',
  runtimeProfileName: null,
  skills: [],
  skillRevisions: undefined,
  connectors: [],
  files: [],
};

/** A workspace holding the connections `names`, resolved as C7 resolves them. */
function workspaceWith(names: readonly string[]) {
  const ids = new Map([
    ['default', DEFAULT_ID],
    [setupConnectionName('anthropic'), SETUP_ID],
  ]);
  return {
    resolveDefinition(references: DefinitionReferences): Promise<ResolveDefinitionOutcome> {
      const name = references.modelConnectionName ?? 'default';
      const id = names.includes(name) ? (ids.get(name) ?? null) : null;
      if (id === null && name !== 'default') {
        return Promise.resolve({
          kind: 'unresolved',
          missing: [{ kind: 'model-connection', name }],
          ambiguous: [],
        });
      }
      return Promise.resolve({
        kind: 'resolved',
        references: {
          modelConnectionId: id,
          runtimeProfileId: null,
          skillIds: [],
          connectorIds: [],
          files: [],
        },
      });
    },
  };
}

async function connectionOf(names: readonly string[], modelConnectionName: string | null) {
  const outcome = await resolveBuilderDefinition(workspaceWith(names), {
    ...REFERENCES,
    modelConnectionName,
  });
  if (outcome.kind !== 'resolved') throw new Error('expected the references to resolve');
  return outcome.references.modelConnectionId;
}

describe('resolveBuilderDefinition', () => {
  it('binds the connection named "default" when there is one, even beside setup\'s', async () => {
    expect(await connectionOf(['default', setupConnectionName('anthropic')], 'default')).toBe(
      DEFAULT_ID,
    );
  });

  it('binds the connection first-run setup made when there is no "default"', async () => {
    expect(await connectionOf([setupConnectionName('anthropic')], 'default')).toBe(SETUP_ID);
    expect(await connectionOf([setupConnectionName('anthropic')], null)).toBe(SETUP_ID);
  });

  it('binds none when neither exists, as C7 does', async () => {
    expect(await connectionOf([], 'default')).toBeNull();
  });

  it("does not fall back to setup's connection when the body names another one", async () => {
    const outcome = await resolveBuilderDefinition(
      workspaceWith([setupConnectionName('anthropic')]),
      { ...REFERENCES, modelConnectionName: 'custom' },
    );
    expect(outcome).toEqual({
      kind: 'unresolved',
      missing: [{ kind: 'model-connection', name: 'custom' }],
      ambiguous: [],
    });
  });
});
