import { describe, expect, it } from 'vitest';

import {
  appKitSatisfies,
  BLUEPRINT_PART_KINDS,
  BlueprintManifestSchema,
  blueprintSidecarPath,
  destructiveMigrations,
  parseBlueprintManifest,
  planBlueprintInstall,
  planBlueprintUpdate,
  type BlueprintAppState,
  type BlueprintFile,
  type BlueprintLocalState,
  type BlueprintManifest,
  type BlueprintRelease,
} from './blueprint.js';
import { ProjectRenderError } from './errors.js';
import {
  addGeneratedEntry,
  EMPTY_GENERATED_MANIFEST,
  type GeneratedEntry,
} from './generated-manifest.js';

const hash = (character: string): string => character.repeat(64);

const source = {
  package: '@acme/helpdesk-blueprint',
  version: '1.2.0',
  integrity: `sha512-${'A'.repeat(86)}==`,
};

const agentText = [
  '---',
  'apiVersion: agentworkspace.dev/v1',
  'kind: Agent',
  'name: triage',
  'permissions:',
  '  readFiles: true',
  '  writeFiles: false',
  '  runCommands: false',
  '  unrestrictedNetwork: false',
  '---',
  'Triage tickets.',
  '',
].join('\n');

const manifest: BlueprintManifest = {
  name: 'helpdesk',
  version: '1.2.0',
  appKit: '^0.9.0',
  parts: [
    { path: 'resources/ticket.ts', kind: 'resource' },
    { path: 'recipes/sla.ts', kind: 'recipe' },
    { path: 'app/tickets/page.tsx', kind: 'page' },
    { path: 'agents/triage.agent.md', kind: 'agent' },
  ],
  slots: {
    connectors: [{ slot: 'email', kind: 'mcp', identity: true }],
    secrets: [{ slot: 'CRM_API_KEY' }],
    agents: [{ name: 'triage' }],
  },
  migrations: ['migrations/0000_create_tickets.sql'],
};

const files: readonly BlueprintFile[] = [
  { path: 'resources/ticket.ts', contents: 'export default 1;\n', sha256: hash('1') },
  { path: 'recipes/sla.ts', contents: 'export default 2;\n', sha256: hash('2') },
  { path: 'app/tickets/page.tsx', contents: 'export default 3;\n', sha256: hash('3') },
  { path: 'agents/triage.agent.md', contents: agentText, sha256: hash('4') },
  {
    path: 'migrations/0000_create_tickets.sql',
    contents: 'CREATE TABLE "app_desk"."tickets" ("id" text PRIMARY KEY);\n',
    sha256: hash('5'),
  },
];

const release: BlueprintRelease = { manifest, files, source };

const app: BlueprintAppState = {
  paths: ['app.config.ts', 'package.json', 'agents/assistant.ts'],
  appKitVersion: '0.9.4',
  manifest: EMPTY_GENERATED_MANIFEST,
  agents: ['assistant'],
  connectors: ['email'],
  secrets: [],
  nextMigrationIndex: 3,
};

function refusals(run: () => unknown): readonly { path: string; message: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ProjectRenderError) return error.issues;
    throw error;
  }
  throw new Error('the plan was not refused');
}

function manifestIssues(value: unknown): readonly string[] {
  const parsed = BlueprintManifestSchema.safeParse(value);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => issue.path.map(String).join('.'));
}

describe('BlueprintManifestSchema', () => {
  it('accepts the ADR-0166 D5 example and every part kind at its root', () => {
    expect(parseBlueprintManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(BLUEPRINT_PART_KINDS).toEqual(['resource', 'recipe', 'page', 'agent', 'skill', 'test']);
    expect(
      manifestIssues({
        ...manifest,
        parts: [
          ...manifest.parts,
          { path: 'skills/triage/SKILL.md', kind: 'skill' },
          { path: 'tests/ticket.test.ts', kind: 'test' },
        ],
      }),
    ).toEqual([]);
  });

  it('refuses unknown keys at every level', () => {
    expect(manifestIssues({ ...manifest, data: [] })).toEqual(['']);
    expect(manifestIssues({ ...manifest, slots: { ...manifest.slots, env: [] } })).toEqual([
      'slots',
    ]);
    expect(
      manifestIssues({
        ...manifest,
        parts: [{ path: 'resources/ticket.ts', kind: 'resource', mode: 'overwrite' }],
        slots: { ...manifest.slots, agents: [] },
      }),
    ).toEqual(['parts.0']);
  });

  it('refuses a secret value and a connector URL in a slot', () => {
    expect(
      manifestIssues({
        ...manifest,
        slots: { ...manifest.slots, secrets: [{ slot: 'CRM_API_KEY', value: 'hunter2' }] },
      }),
    ).toEqual(['slots.secrets.0']);
    expect(
      manifestIssues({
        ...manifest,
        slots: {
          ...manifest.slots,
          connectors: [{ slot: 'email', kind: 'mcp', url: 'https://mail.example/mcp' }],
        },
      }),
    ).toEqual(['slots.connectors.0']);
    expect(
      manifestIssues({ ...manifest, slots: { ...manifest.slots, secrets: [{ slot: 'PORT' }] } }),
    ).toEqual(['slots.secrets.0.slot']);
  });

  it("refuses '..', absolute, backslash and environment-file part paths", () => {
    for (const path of [
      '../resources/ticket.ts',
      'app/../../etc/passwd',
      '/app/page.tsx',
      'app\\page.tsx',
      'app/.env',
      'tests/.env.local',
    ]) {
      expect(
        manifestIssues({ ...manifest, parts: [...manifest.parts, { path, kind: 'page' }] }),
        path,
      ).toContain('parts.4.path');
    }
  });

  it("refuses a part outside its kind's directory", () => {
    for (const [path, kind] of [
      ['app.config.ts', 'resource'],
      ['agents/triage.ts', 'agent'],
      ['resources/nested/ticket.ts', 'resource'],
      ['package.json', 'page'],
      ['agent-workspace.yaml', 'skill'],
      ['app/page.tsx', 'test'],
    ] as const) {
      expect(
        manifestIssues({ ...manifest, parts: [...manifest.parts, { path, kind }] }),
        path,
      ).toContain('parts.4.path');
    }
  });

  it('refuses a malformed name, version, range or migration path, and duplicates', () => {
    expect(manifestIssues({ ...manifest, name: 'Help Desk' })).toEqual(['name']);
    expect(manifestIssues({ ...manifest, version: '^1.2.0' })).toEqual(['version']);
    expect(manifestIssues({ ...manifest, appKit: '>=0.9.0' })).toEqual(['appKit']);
    expect(manifestIssues({ ...manifest, appKit: '^0.9.0-beta.1' })).toEqual(['appKit']);
    expect(manifestIssues({ ...manifest, migrations: ['db/0001_a.sql'] })).toEqual([
      'migrations.0',
    ]);
    expect(
      manifestIssues({ ...manifest, migrations: [...manifest.migrations, ...manifest.migrations] }),
    ).toEqual(['migrations.1']);
  });

  it('pairs each agent slot with its .agent.md part', () => {
    expect(manifestIssues({ ...manifest, slots: { ...manifest.slots, agents: [] } })).toEqual([
      'parts.3.path',
    ]);
    expect(
      manifestIssues({
        ...manifest,
        slots: { ...manifest.slots, agents: [{ name: 'triage' }, { name: 'router' }] },
      }),
    ).toEqual(['slots.agents.1.name']);
  });

  it('refuses text that is not JSON, naming the file', () => {
    expect(() => parseBlueprintManifest('{')).toThrow('blueprint.json could not be rendered');
  });
});

describe('appKitSatisfies', () => {
  it.each([
    ['0.9.0', '0.9.0', true],
    ['0.9.0', '0.9.1', false],
    ['1.0.0-beta.1', '1.0.0-beta.1', true],
    ['1.0.0', '1.0.0-beta.1', false],
    ['^1.2.3', '1.2.3', true],
    ['^1.2.3', '1.9.0', true],
    ['^1.2.3', '2.0.0', false],
    ['^1.2.3', '1.2.2', false],
    ['^0.9.0', '0.9.7', true],
    ['^0.9.0', '0.10.0', false],
    ['^0.0.3', '0.0.3', true],
    ['^0.0.3', '0.0.4', false],
    ['^1.2.3', '1.3.0-rc.1', false],
    ['~1.2.3', '1.2.9', true],
    ['~1.2.3', '1.3.0', false],
    ['~0.9.1', '0.9.0', false],
    ['^1.2.3', '1.10.0', true],
    ['~1.2.3', '1.2.10', true],
    ['>=1.0.0', '1.0.0', false],
    ['^1.2.3', 'latest', false],
  ])('%s against %s is %s', (range, version, expected) => {
    expect(appKitSatisfies(range, version)).toBe(expected);
  });
});

describe('destructiveMigrations', () => {
  it.each([
    ['ALTER TABLE "a" DROP COLUMN "b";', 'DROP'],
    ['DROP TABLE "a";', 'DROP'],
    ['ALTER TABLE "a" ALTER COLUMN "b" TYPE integer;', 'ALTER COLUMN TYPE'],
    ['ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;', 'SET NOT NULL'],
    ['ALTER TABLE "a" RENAME COLUMN "b" TO "c";', 'RENAME'],
    ['ALTER TABLE "a" ADD CONSTRAINT "c" CHECK ("b" > 0);', 'CHECK without NOT VALID'],
  ])('names %s by its file and rule', (sql, rule) => {
    expect(destructiveMigrations('migrations/0001_x.sql', sql)).toEqual([
      { path: 'migrations/0001_x.sql', rule, statement: sql },
    ]);
  });

  it('accepts CREATE TABLE, ADD COLUMN and DROP DEFAULT, and ignores comments', () => {
    const sql = [
      'CREATE TABLE "a" ("id" text PRIMARY KEY);',
      '--> statement-breakpoint',
      'ALTER TABLE "a" ADD COLUMN "b" text;',
      '--> statement-breakpoint',
      'ALTER TABLE "a" ALTER COLUMN "b" DROP DEFAULT; -- DROP TABLE "a"',
      '--> statement-breakpoint',
      'ALTER TABLE "a" ADD CONSTRAINT "c" CHECK ("b" <> \'\') NOT VALID;',
    ].join('\n');
    expect(destructiveMigrations('migrations/0001_x.sql', sql)).toEqual([]);
  });

  it.each([
    [`CREATE TABLE "a" ("b" text DEFAULT '--'); DROP TABLE "c";`, 'DROP'],
    [`CREATE TABLE "a" ("b--x" text); DROP TABLE "c";`, 'DROP'],
    [`CREATE TABLE "a" ("b" text DEFAULT E'\\'--'); DROP TABLE "c";`, 'DROP'],
    [
      'CREATE FUNCTION "f"() RETURNS text AS $$ SELECT \'--\' $$ LANGUAGE sql; DROP TABLE "c";',
      'DROP',
    ],
    ['CREATE TABLE "a" ("b" text DEFAULT $x$--$x$); DROP TABLE "c";', 'DROP'],
    ['/* outer /* inner */ still a comment */ DROP TABLE "c";', 'DROP'],
    ['CREATE TABLE "a" ("b" text); /* never closed DROP TABLE "c";', 'DROP'],
    ['TRUNCATE "c";', 'TRUNCATE'],
    ['DELETE FROM "d";', 'DELETE'],
    ['DELETE/**/FROM "d";', 'DELETE'],
    ["DO $$ BEGIN EXECUTE 'DR' || 'OP TABLE c'; END $$;", 'DO'],
    ["SELECT 1; EXECUTE 'x';", 'EXECUTE'],
    ['SET standard_conforming_strings = off;', 'standard_conforming_strings'],
  ])('refuses %s, whatever its quotes and comments hide (%s)', (sql, rule) => {
    expect(destructiveMigrations('m.sql', sql).map((finding) => finding.rule)).toContain(rule);
  });

  it('accepts ON DELETE, ON CONFLICT DO NOTHING and a trigger that executes a function', () => {
    const sql = [
      'CREATE TABLE "t" ("id" text PRIMARY KEY, "p" text REFERENCES "p"("id") ON DELETE CASCADE);',
      '--> statement-breakpoint',
      'INSERT INTO "t" ("id") VALUES (\'a\') ON CONFLICT DO NOTHING;',
      '--> statement-breakpoint',
      'CREATE TRIGGER "x" BEFORE UPDATE ON "t" FOR EACH ROW EXECUTE FUNCTION "touch"();',
    ].join('\n');
    expect(destructiveMigrations('m.sql', sql)).toEqual([]);
  });

  it('reads quoted text as code, so a rule word inside a string refuses rather than hides', () => {
    const sql = 'CREATE TABLE "q" ("note" text DEFAULT \'DROP is a word -- here\');';
    expect(destructiveMigrations('m.sql', sql).map((finding) => finding.rule)).toEqual(['DROP']);
  });

  it("does not honour the repository lint's -- safe: exception", () => {
    expect(
      destructiveMigrations('m.sql', '-- safe: the table is empty\nDROP TABLE "a";'),
    ).toHaveLength(1);
  });
});

describe('planBlueprintInstall', () => {
  it('writes each part at its path and renumbers each migration, recording the entry', () => {
    const plan = planBlueprintInstall(release, app);

    expect(plan.key).toBe('blueprint:helpdesk');
    expect(plan.writes.map((write) => [write.from, write.path])).toEqual([
      ['agents/triage.agent.md', 'agents/triage.agent.md'],
      ['app/tickets/page.tsx', 'app/tickets/page.tsx'],
      ['migrations/0000_create_tickets.sql', 'db/migrations/0003_create_tickets.sql'],
      ['recipes/sla.ts', 'recipes/sla.ts'],
      ['resources/ticket.ts', 'resources/ticket.ts'],
    ]);
    expect(plan.migrations).toEqual([
      {
        from: 'migrations/0000_create_tickets.sql',
        path: 'db/migrations/0003_create_tickets.sql',
        idx: 3,
        tag: '0003_create_tickets',
      },
    ]);
    expect(plan.slots).toEqual([
      { kind: 'connector', slot: 'email', bound: true },
      { kind: 'secret', slot: 'CRM_API_KEY', bound: false },
    ]);
    expect(plan.wiring).toEqual({ resources: ['ticket'], recipes: ['sla'] });
    expect(plan.entry).toEqual({
      files: {
        'resources/ticket.ts': hash('1'),
        'recipes/sla.ts': hash('2'),
        'app/tickets/page.tsx': hash('3'),
        'agents/triage.agent.md': hash('4'),
        'db/migrations/0003_create_tickets.sql': hash('5'),
      },
      edits: [],
      source,
      migrations: { 'migrations/0000_create_tickets.sql': 'db/migrations/0003_create_tickets.sql' },
    });
    // The entry is one the generated-file manifest accepts.
    expect(() =>
      addGeneratedEntry(EMPTY_GENERATED_MANIFEST, plan.key, plan.entry),
    ).not.toThrowError();
  });

  it('refuses an appKit mismatch and a missing app kit', () => {
    expect(
      refusals(() => planBlueprintInstall(release, { ...app, appKitVersion: '0.10.0' })),
    ).toEqual([
      { path: 'appKit', message: 'needs @indx-workspace/app ^0.9.0; the app has 0.10.0' },
    ]);
    expect(
      refusals(() => planBlueprintInstall(release, { ...app, appKitVersion: undefined })),
    ).toEqual([
      {
        path: 'appKit',
        message: 'needs @indx-workspace/app ^0.9.0, which the app does not have',
      },
    ]);
  });

  it('refuses a path collision, naming the path', () => {
    const recorded = addGeneratedEntry(EMPTY_GENERATED_MANIFEST, 'page:tickets', {
      files: { 'app/tickets/page.tsx': hash('9') },
      edits: [],
    });
    expect(
      refusals(() =>
        planBlueprintInstall(release, {
          ...app,
          paths: [...app.paths, 'resources/ticket.ts', 'db/migrations/0003_create_tickets.sql'],
          manifest: recorded,
        }),
      ),
    ).toEqual([
      { path: 'resources/ticket.ts', message: 'exists already' },
      { path: 'app/tickets/page.tsx', message: 'is recorded by page:tickets already' },
      { path: 'db/migrations/0003_create_tickets.sql', message: 'exists already' },
    ]);
  });

  it('refuses a blueprint installed already and an agent the project defines', () => {
    const installed = addGeneratedEntry(
      EMPTY_GENERATED_MANIFEST,
      'blueprint:helpdesk',
      planBlueprintInstall(release, app).entry,
    );
    expect(
      refusals(() =>
        planBlueprintInstall(release, { ...app, manifest: installed, agents: ['triage'] }),
      ).map((issue) => issue.path),
    ).toEqual(['blueprint:helpdesk', 'slots.agents.triage']);
  });

  it('refuses a file not listed, a listed file missing, a binary file and a version mismatch', () => {
    const extra = { path: 'scripts/postinstall.js', contents: 'x', sha256: hash('6') };
    const others = files.filter((file) => file.path !== 'recipes/sla.ts');
    expect(
      refusals(() =>
        planBlueprintInstall(
          {
            manifest,
            files: [
              ...others.map((f) =>
                f.path === 'app/tickets/page.tsx' ? { ...f, contents: 'a\0b' } : f,
              ),
              extra,
            ],
            source: { ...source, version: '1.2.1' },
          },
          app,
        ),
      ),
    ).toEqual([
      { path: 'version', message: 'is 1.2.0, but the package is version 1.2.1' },
      { path: 'app/tickets/page.tsx', message: 'is not a text file' },
      { path: 'scripts/postinstall.js', message: 'is not a part blueprint.json lists' },
      {
        path: 'recipes/sla.ts',
        message: 'is listed in blueprint.json but missing from the package',
      },
    ]);
  });

  it('refuses a destructive migration by name', () => {
    const destructive = files.map((file) =>
      file.path.startsWith('migrations/') ? { ...file, contents: 'DROP TABLE "tickets";' } : file,
    );
    expect(refusals(() => planBlueprintInstall({ ...release, files: destructive }, app))).toEqual([
      {
        path: 'migrations/0000_create_tickets.sql',
        message: 'is not expand-only (DROP): DROP TABLE "tickets";',
      },
    ]);
  });

  it('refuses an agent part that is not an agent file, or carries a URL or an unlisted secret', () => {
    const withAgent = (contents: string): BlueprintRelease => ({
      ...release,
      files: files.map((file) => (file.path.startsWith('agents/') ? { ...file, contents } : file)),
    });
    expect(
      refusals(() => planBlueprintInstall(withAgent('no front matter'), app)).map((i) => i.path),
    ).toEqual(['agents/triage.agent.md']);
    expect(
      refusals(() =>
        planBlueprintInstall(withAgent(agentText.replace('name: triage', 'name: other')), app),
      ),
    ).toEqual([
      { path: 'agents/triage.agent.md', message: "names the agent other, not its file's name" },
    ]);
    const withTools = agentText.replace(
      '---\nTriage',
      [
        'tools:',
        '  - kind: mcp',
        '    name: crm',
        '    transport: streamable-http',
        '    url: https://crm.example.com/mcp',
        '  - kind: openapi',
        '    name: orders',
        '    specRef: openapi/orders.json',
        '    auth:',
        '      secretRef: ORDERS_KEY',
        '---',
        'Triage',
      ].join('\n'),
    );
    expect(refusals(() => planBlueprintInstall(withAgent(withTools), app))).toEqual([
      {
        path: 'agents/triage.agent.md: tools.0',
        message:
          'carries a connector URL; the installing app binds connectors in agent-workspace.yaml',
      },
      {
        path: 'agents/triage.agent.md: tools.1',
        message: 'refers to the secret ORDERS_KEY, which slots.secrets does not list',
      },
    ]);
  });
});

describe('planBlueprintUpdate', () => {
  const installed: GeneratedEntry = planBlueprintInstall(release, app).entry;
  const installedApp: BlueprintAppState = {
    ...app,
    paths: [...app.paths, ...Object.keys(installed.files)],
    manifest: addGeneratedEntry(EMPTY_GENERATED_MANIFEST, 'blueprint:helpdesk', installed),
    agents: ['assistant', 'triage'],
    nextMigrationIndex: 4,
  };
  const local: BlueprintLocalState = { ...installedApp, hashes: installed.files };
  const nextSource = { ...source, version: '1.3.0', integrity: `sha512-${'B'.repeat(86)}==` };
  const nextManifest: BlueprintManifest = {
    ...manifest,
    version: '1.3.0',
    parts: [
      ...manifest.parts.filter((part) => part.path !== 'recipes/sla.ts'),
      { path: 'resources/queue.ts', kind: 'resource' },
    ],
    migrations: [...manifest.migrations, 'migrations/0001_add_priority.sql'],
  };
  const nextFiles: readonly BlueprintFile[] = [
    ...files
      .filter((file) => file.path !== 'recipes/sla.ts')
      .map((file) =>
        file.path === 'resources/ticket.ts' || file.path === 'app/tickets/page.tsx'
          ? { ...file, contents: `${file.contents}// 1.3.0\n`, sha256: hash('a') }
          : file,
      ),
    { path: 'resources/queue.ts', contents: 'export default 7;\n', sha256: hash('7') },
    {
      path: 'migrations/0001_add_priority.sql',
      contents: 'ALTER TABLE "app_desk"."tickets" ADD COLUMN "priority" text;\n',
      sha256: hash('8'),
    },
  ];
  const next: BlueprintRelease = { manifest: nextManifest, files: nextFiles, source: nextSource };

  it('reports add, update, remove and unchanged for an unedited app', () => {
    const plan = planBlueprintUpdate(installed, next, local);

    expect(plan.changes.map((change) => [change.path, change.action, change.write])).toEqual([
      ['agents/triage.agent.md', 'unchanged', undefined],
      ['app/tickets/page.tsx', 'update', 'app/tickets/page.tsx'],
      ['db/migrations/0003_create_tickets.sql', 'unchanged', undefined],
      ['db/migrations/0004_add_priority.sql', 'add', 'db/migrations/0004_add_priority.sql'],
      ['recipes/sla.ts', 'remove', undefined],
      ['resources/queue.ts', 'add', 'resources/queue.ts'],
      ['resources/ticket.ts', 'update', 'resources/ticket.ts'],
    ]);
    expect(plan.migrations).toEqual([
      {
        from: 'migrations/0001_add_priority.sql',
        path: 'db/migrations/0004_add_priority.sql',
        idx: 4,
        tag: '0004_add_priority',
      },
    ]);
    expect(plan.wiring).toEqual({
      add: { resources: ['queue'], recipes: [] },
      remove: { resources: [], recipes: ['sla'] },
      keep: { resources: [], recipes: [] },
    });
    expect(plan.entry.source).toEqual(nextSource);
    expect(plan.entry.files['recipes/sla.ts']).toBeUndefined();
    expect(plan.entry.files['resources/ticket.ts']).toBe(hash('a'));
    expect(plan.entry.migrations).toEqual({
      'migrations/0000_create_tickets.sql': 'db/migrations/0003_create_tickets.sql',
      'migrations/0001_add_priority.sql': 'db/migrations/0004_add_priority.sql',
    });
  });

  it('proposes an edited file as a conflict, written only to its sidecar', () => {
    const edited: BlueprintLocalState = {
      ...local,
      hashes: { ...local.hashes, 'resources/ticket.ts': hash('e'), 'recipes/sla.ts': hash('e') },
    };
    const plan = planBlueprintUpdate(installed, next, edited);
    const byPath = new Map(plan.changes.map((change) => [change.path, change]));

    expect(byPath.get('resources/ticket.ts')).toMatchObject({
      action: 'conflict',
      write: blueprintSidecarPath('resources/ticket.ts', '1.3.0'),
    });
    expect(blueprintSidecarPath('resources/ticket.ts', '1.3.0')).toBe(
      'resources/ticket.ts.blueprint-1.3.0',
    );
    // Removed upstream but edited here: kept, never written, and no longer recorded.
    expect(byPath.get('recipes/sla.ts')).toEqual({ path: 'recipes/sla.ts', action: 'conflict' });
    expect(plan.entry.files['recipes/sla.ts']).toBeUndefined();
    // Its app.config.ts wiring stays with it: kept, never reverted (ADR-0166 D7).
    expect(plan.wiring).toEqual({
      add: { resources: ['queue'], recipes: [] },
      remove: { resources: [], recipes: [] },
      keep: { resources: [], recipes: ['sla'] },
    });
    // The new version's hash is recorded for the conflicted path (ADR-0166 D7).
    expect(plan.entry.files['resources/ticket.ts']).toBe(hash('a'));
  });

  it('reverts the wiring of a dropped file the developer already deleted', () => {
    const hashes = Object.fromEntries(
      Object.entries(local.hashes).filter(([path]) => path !== 'recipes/sla.ts'),
    );
    const plan = planBlueprintUpdate(installed, next, { ...local, hashes });
    expect(plan.wiring.remove).toEqual({ resources: [], recipes: ['sla'] });
    expect(plan.wiring.keep).toEqual({ resources: [], recipes: [] });
  });

  it('proposes nothing for an edit the new version leaves alone or already matches', () => {
    const edited: BlueprintLocalState = {
      ...local,
      hashes: {
        ...local.hashes,
        'agents/triage.agent.md': hash('e'),
        'resources/ticket.ts': hash('a'),
      },
    };
    const byPath = new Map(
      planBlueprintUpdate(installed, next, edited).changes.map((c) => [c.path, c.action]),
    );
    expect(byPath.get('agents/triage.agent.md')).toBe('unchanged');
    expect(byPath.get('resources/ticket.ts')).toBe('unchanged');
  });

  it('refuses while a sidecar of an earlier update exists, naming it', () => {
    const sidecar = 'resources/ticket.ts.blueprint-1.2.5';
    expect(
      refusals(() =>
        planBlueprintUpdate(installed, next, { ...local, paths: [...local.paths, sidecar] }),
      ),
    ).toEqual([
      {
        path: sidecar,
        message: 'is the unmerged proposal of an earlier update; merge or delete it first',
      },
    ]);
  });

  it('refuses an added file that collides with one the app has', () => {
    expect(
      refusals(() =>
        planBlueprintUpdate(installed, next, {
          ...local,
          paths: [...local.paths, 'resources/queue.ts'],
        }),
      ),
    ).toEqual([{ path: 'resources/queue.ts', message: 'exists already' }]);
  });

  it('refuses a destructive new migration, and an installed migration changed or dropped', () => {
    const destructive = nextFiles.map((file) =>
      file.path === 'migrations/0001_add_priority.sql'
        ? { ...file, contents: 'ALTER TABLE "app_desk"."tickets" DROP COLUMN "title";' }
        : file,
    );
    expect(
      refusals(() => planBlueprintUpdate(installed, { ...next, files: destructive }, local)),
    ).toEqual([
      {
        path: 'migrations/0001_add_priority.sql',
        message: 'is not expand-only (DROP): ALTER TABLE "app_desk"."tickets" DROP COLUMN "title";',
      },
    ]);
    const changed = nextFiles.map((file) =>
      file.path === 'migrations/0000_create_tickets.sql' ? { ...file, sha256: hash('c') } : file,
    );
    expect(
      refusals(() => planBlueprintUpdate(installed, { ...next, files: changed }, local)),
    ).toEqual([
      {
        path: 'migrations/0000_create_tickets.sql',
        message: 'is installed, and 1.3.0 changes it; a version may only append migrations',
      },
    ]);
    const dropped: BlueprintRelease = {
      ...next,
      manifest: { ...nextManifest, migrations: ['migrations/0001_add_priority.sql'] },
      files: nextFiles.filter((file) => file.path !== 'migrations/0000_create_tickets.sql'),
    };
    expect(refusals(() => planBlueprintUpdate(installed, dropped, local))).toEqual([
      {
        path: 'migrations/0000_create_tickets.sql',
        message: 'is installed, and 1.3.0 drops it; a version may only append migrations',
      },
    ]);
  });

  it('refuses another package and a re-published version', () => {
    expect(
      refusals(() =>
        planBlueprintUpdate(
          installed,
          { ...next, source: { ...nextSource, package: 'other' } },
          local,
        ),
      ).map((issue) => issue.path),
    ).toEqual(['source.package']);
    expect(
      refusals(() =>
        planBlueprintUpdate(
          installed,
          { ...release, source: { ...source, integrity: nextSource.integrity } },
          local,
        ),
      ).map((issue) => issue.path),
    ).toEqual(['source.integrity']);
  });

  it('refuses an entry that is not a blueprint', () => {
    expect(refusals(() => planBlueprintUpdate({ files: {}, edits: [] }, next, local))).toEqual([
      { path: 'blueprint:helpdesk', message: 'is not a blueprint entry' },
    ]);
  });
});
