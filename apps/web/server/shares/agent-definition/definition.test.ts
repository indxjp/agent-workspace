import { describe, expect, it } from 'vitest';
import { exportAgentDefinition, missingRequirements } from './definition';

describe('agent definition shares', () => {
  it('replaces credential material and names everything the importer must supply', () => {
    const exported = exportAgentDefinition(
      {
        name: 'Triage',
        instructions: 'Use sk_live_secret',
        modelConnectionName: 'Claude',
        connectorNames: ['Jira'],
        fileCount: 2,
        credentialId: 'secret-id',
      },
      ['sk_live_secret'],
      ['secret-id'],
    );
    expect(JSON.stringify(exported)).not.toContain('sk_live_secret');
    expect(JSON.stringify(exported)).not.toContain('secret-id');
    expect(exported.requirements).toEqual([
      'a model connection (any Claude-capable provider)',
      'connector "Jira" (you will be asked for your own credentials)',
      '2 files (not included in this share)',
    ]);
    expect(missingRequirements(exported, [])).toEqual(exported.requirements);
  });
});
