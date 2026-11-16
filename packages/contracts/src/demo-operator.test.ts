import { describe, expect, it } from 'vitest';

import {
  DemoMaintenanceRequestSchema,
  DemoReadinessSchema,
  DemoSampleRecordsSchema,
  DemoSeedFileSchema,
  DemoSeedSkillSchema,
  DemoTemplateSeedSchema,
  DemoVerificationFillSchema,
} from './demo-operator.js';

const definition = {
  apiVersion: 'agentworkspace.dev/v1',
  kind: 'AgentDefinition',
  agent: {
    name: 'sales-assistant',
    instructions: 'Sample data only.',
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    model: null,
    modelConnectionName: null,
    runtimeProfileName: null,
  },
  policy: { engine: 'claude-agent-sdk', skills: { mode: 'all' } },
  resources: { files: [], skills: [], connectors: ['crm'] },
};

describe('a template seed', () => {
  it('carries a definition, its connectors by read and write tools, files and records', () => {
    const parsed = DemoTemplateSeedSchema.safeParse({
      definition,
      connectors: [{ name: 'crm', reads: ['company_search'], writes: ['contact_update'] }],
      skills: [],
      files: [{ path: 'deals/q1.csv', base64: 'aWQsYW1vdW50Cg==' }],
      records: [
        {
          connector: 'crm',
          resource: 'company',
          lang: 'en',
          tools: ['company_search'],
          data: [{ id: 'c1', name: 'Sample Co.' }],
        },
      ],
    });
    // The definition's own shape is the K-1 contract's; only the seed's own keys are checked here.
    if (!parsed.success) {
      const own = parsed.error.issues.filter((issue) => issue.path[0] !== 'definition');
      expect(own).toEqual([]);
    }
  });

  it.each(['demo-template', 'demo-template/seed.sha256', 'demo-template/records/crm/a.json'])(
    'refuses the file path %j: it is in the folder the template keeps its own files in',
    (path) => {
      expect(DemoSeedFileSchema.safeParse({ path, base64: 'YQ==' }).success).toBe(false);
    },
  );

  it('accepts a sample file whose folder only starts like the reserved one', () => {
    expect(
      DemoSeedFileSchema.safeParse({ path: 'demo-templates/a.txt', base64: 'YQ==' }).success,
    ).toBe(true);
  });

  it.each(['kb_article', 'parts', 'ticket-notes'])(
    'accepts the record set resource %j, as a source names it',
    (resource) => {
      expect(
        DemoSampleRecordsSchema.safeParse({
          connector: 'service-desk',
          resource,
          lang: 'en',
          tools: ['kb_article_list'],
          data: [],
        }).success,
      ).toBe(true);
    },
  );

  it.each(['', '../x', 'a/b', 'a.json', '1abc'])(
    'refuses the record set resource %j: it names a file of the template',
    (resource) => {
      expect(
        DemoSampleRecordsSchema.safeParse({
          connector: 'crm',
          resource,
          lang: 'en',
          tools: ['company_list'],
          data: [],
        }).success,
      ).toBe(false);
    },
  );

  it.each(['/etc/passwd', '../up.txt', 'a//b.txt', 'a/../b.txt'])(
    'refuses the file path %j',
    (path) => {
      expect(DemoSeedFileSchema.safeParse({ path, base64: 'YQ==' }).success).toBe(false);
    },
  );

  it('carries a skill by its name and its files, SKILL.md among them', () => {
    const files = [
      { path: 'SKILL.md', base64: 'IyBjb3N0' },
      { path: 'scripts/estimate.mjs', base64: 'ZXhwb3J0IHt9' },
    ];
    expect(DemoSeedSkillSchema.safeParse({ name: 'cost-model', files }).success).toBe(true);
    expect(
      DemoSeedSkillSchema.safeParse({ name: 'cost-model', files: files.slice(1) }).success,
    ).toBe(false);
    expect(DemoSeedSkillSchema.safeParse({ name: 'cost-model', files: [] }).success).toBe(false);
    expect(DemoSeedSkillSchema.safeParse({ name: 'Cost Model', files }).success).toBe(false);
    expect(
      DemoSeedSkillSchema.safeParse({
        name: 'cost-model',
        files: [...files, { path: '../up.mjs', base64: 'YQ==' }],
      }).success,
    ).toBe(false);
  });

  it('never carries a built-in skill: the definition names it and the platform installs it', () => {
    const files = [{ path: 'SKILL.md', base64: 'IyBjb3N0' }];
    expect(DemoSeedSkillSchema.safeParse({ name: 'office-reader', files }).success).toBe(false);
  });

  it('refuses a record set with no tool, or one too large', () => {
    const records = { connector: 'crm', resource: 'company', lang: 'ja', tools: [], data: [] };
    expect(DemoSampleRecordsSchema.safeParse(records).success).toBe(false);
    const big = { ...records, tools: ['company_list'], data: 'x'.repeat(262_145) };
    expect(DemoSampleRecordsSchema.safeParse(big).success).toBe(false);
  });
});

describe('the maintenance and readiness words', () => {
  it('takes a state and a reason in words', () => {
    expect(
      DemoMaintenanceRequestSchema.safeParse({ state: 'maintenance', reason: 'a tool did not run' })
        .success,
    ).toBe(true);
    expect(DemoMaintenanceRequestSchema.safeParse({ state: 'broken', reason: 'x' }).success).toBe(
      false,
    );
  });

  it('reports readiness as two booleans and nothing else', () => {
    expect(
      DemoReadinessSchema.safeParse({ apiKeyConfigured: true, apiReachable: false, key: 'sk' })
        .success,
    ).toBe(false);
  });
});

describe('the verification workspace fill', () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001';

  it('names the workspace and the entries copied into it', () => {
    expect(
      DemoVerificationFillSchema.safeParse({ workspaceId, entries: ['crm-sales', 'wiki'] }).success,
    ).toBe(true);
    expect(DemoVerificationFillSchema.safeParse({ workspaceId, entries: [] }).success).toBe(true);
  });

  it('refuses a workspace that is not an id, an entry that is not a slug, or another key', () => {
    expect(
      DemoVerificationFillSchema.safeParse({ workspaceId: 'store-verification', entries: [] })
        .success,
    ).toBe(false);
    expect(
      DemoVerificationFillSchema.safeParse({ workspaceId, entries: ['Not A Slug'] }).success,
    ).toBe(false);
    expect(
      DemoVerificationFillSchema.safeParse({ workspaceId, entries: [], apiKey: 'ak_live_x' })
        .success,
    ).toBe(false);
    expect(DemoVerificationFillSchema.safeParse({ entries: [] }).success).toBe(false);
  });
});
