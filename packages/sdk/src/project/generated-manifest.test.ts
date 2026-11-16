import { describe, expect, it } from 'vitest';

import { ProjectRenderError } from './errors.js';
import {
  addGeneratedEntry,
  EMPTY_GENERATED_MANIFEST,
  generatedEntryKey,
  parseGeneratedManifest,
  removeGeneratedEntry,
  serializeGeneratedManifest,
  type GeneratedEntry,
} from './generated-manifest.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const ticket: GeneratedEntry = {
  files: { 'resources/ticket.ts': HASH_A, 'app/api/tickets/route.ts': HASH_B },
  edits: [{ path: 'app.config.ts', added: "import ticket from './resources/ticket.ts';" }],
};

function refusedPaths(text: string): readonly string[] {
  try {
    parseGeneratedManifest(text);
  } catch (error) {
    if (error instanceof ProjectRenderError) return error.issues.map((issue) => issue.path);
    throw error;
  }
  throw new Error('the manifest was accepted');
}

describe('aw-generated.json', () => {
  it('round-trips an entry through add, serialize, parse and remove', () => {
    const key = generatedEntryKey('resource', 'ticket');
    const added = addGeneratedEntry(EMPTY_GENERATED_MANIFEST, key, ticket);
    const text = serializeGeneratedManifest(added);
    const parsed = parseGeneratedManifest(text);

    expect(parsed).toEqual(added);
    expect(Object.keys(parsed.entries['resource:ticket']?.files ?? {})).toEqual([
      'app/api/tickets/route.ts',
      'resources/ticket.ts',
    ]);
    expect(removeGeneratedEntry(parsed, key)).toEqual(EMPTY_GENERATED_MANIFEST);
  });

  it('serializes with sorted keys, two-space indent and a final newline', () => {
    const manifest = addGeneratedEntry(
      addGeneratedEntry(EMPTY_GENERATED_MANIFEST, 'resource:ticket', ticket),
      'app:desk',
      { files: { 'app.config.ts': HASH_A }, edits: [] },
    );

    expect(serializeGeneratedManifest(manifest)).toBe(
      [
        '{',
        '  "version": 1,',
        '  "entries": {',
        '    "app:desk": {',
        '      "files": {',
        `        "app.config.ts": "${HASH_A}"`,
        '      },',
        '      "edits": []',
        '    },',
        '    "resource:ticket": {',
        '      "files": {',
        `        "app/api/tickets/route.ts": "${HASH_B}",`,
        `        "resources/ticket.ts": "${HASH_A}"`,
        '      },',
        '      "edits": [',
        '        {',
        '          "path": "app.config.ts",',
        `          "added": "import ticket from './resources/ticket.ts';"`,
        '        }',
        '      ]',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('returns frozen manifests', () => {
    const manifest = addGeneratedEntry(EMPTY_GENERATED_MANIFEST, 'resource:ticket', ticket);

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.entries)).toBe(true);
    expect(Object.isFrozen(manifest.entries['resource:ticket']?.files)).toBe(true);
  });

  it('refuses an unknown key anywhere, never starting fresh', () => {
    expect(refusedPaths('{"version":1,"entries":{},"extra":true}')).toEqual(['(root)']);
    expect(
      refusedPaths(
        JSON.stringify({ version: 1, entries: { 'app:desk': { files: {}, edits: [], x: 1 } } }),
      ),
    ).toEqual(['entries.app:desk']);
  });

  it('reads the project:<name> entry create --template records, and still refuses an unknown kind (#1531)', () => {
    const project: GeneratedEntry = { files: { 'package.json': HASH_A }, edits: [] };
    const text = serializeGeneratedManifest(
      addGeneratedEntry(EMPTY_GENERATED_MANIFEST, generatedEntryKey('project', 'acme'), project),
    );

    expect(parseGeneratedManifest(text).entries['project:acme']).toEqual(project);
    expect(refusedPaths(text.replace('"project:acme"', '"template:portal"'))).toEqual([
      'entries.template:portal',
    ]);
  });

  it('refuses text that is not JSON, another version and a missing field', () => {
    expect(refusedPaths('{')).toEqual(['(root)']);
    expect(refusedPaths('{"version":2,"entries":{}}')).toEqual(['version']);
    expect(refusedPaths('{"version":1}')).toEqual(['entries']);
  });

  it('refuses a path that leaves the project, a bad hash, a bad key and a multi-line edit', () => {
    const manifest = {
      version: 1,
      entries: {
        'resource:ticket': {
          files: { '../outside.ts': HASH_A, 'ok.ts': 'not-a-hash' },
          edits: [{ path: '/etc/passwd', added: 'a\nb' }],
        },
        'widget:home': { files: {}, edits: [] },
      },
    };

    expect(refusedPaths(JSON.stringify(manifest))).toEqual(
      expect.arrayContaining([
        'entries.resource:ticket.files.../outside.ts',
        'entries.resource:ticket.files.ok.ts',
        'entries.resource:ticket.edits.0.path',
        'entries.resource:ticket.edits.0.added',
        'entries.widget:home',
      ]),
    );
  });

  it('keeps the line an edit replaced, and refuses one of two lines (#1519)', () => {
    const edit = {
      path: 'app/api/messages/route.ts',
      added: 'export const { GET, POST } = resourceRoutes(message, { publish: messageChannel });',
      replaced: 'export const { GET, POST } = resourceRoutes(message);',
    };
    const text = JSON.stringify({
      version: 1,
      entries: { 'channel:message': { files: {}, edits: [edit] } },
    });
    expect(parseGeneratedManifest(text).entries['channel:message']?.edits).toEqual([edit]);
    expect(refusedPaths(text.replace('resourceRoutes(message);', 'a\\nb'))).toEqual([
      'entries.channel:message.edits.0.replaced',
    ]);
  });

  it('refuses adding an entry twice and removing one that is not there', () => {
    const manifest = addGeneratedEntry(EMPTY_GENERATED_MANIFEST, 'resource:ticket', ticket);

    expect(() => addGeneratedEntry(manifest, 'resource:ticket', ticket)).toThrow(
      'aw-generated.json could not be rendered: resource:ticket: is already generated; destroy it first',
    );
    expect(() => removeGeneratedEntry(manifest, 'agent:triage')).toThrow(
      'agent:triage: was not generated, so there is nothing to remove',
    );
    expect(() => addGeneratedEntry(manifest, 'Bad Key', ticket)).toThrow(ProjectRenderError);
  });
});

describe('aw-generated.json blueprint entries (ADR-0166 D6)', () => {
  const source = {
    package: '@acme/helpdesk-blueprint',
    version: '1.2.0',
    integrity: `sha512-${'A'.repeat(86)}==`,
  };
  const blueprint: GeneratedEntry = {
    files: { 'resources/ticket.ts': HASH_A, 'db/migrations/0003_create_tickets.sql': HASH_B },
    edits: [{ path: 'app.config.ts', added: "import ticket from './resources/ticket.ts';" }],
    source,
    migrations: { 'migrations/0000_create_tickets.sql': 'db/migrations/0003_create_tickets.sql' },
  };

  it('records a blueprint:<name> entry with its source and migrations, and round-trips it', () => {
    const key = generatedEntryKey('blueprint', 'helpdesk');
    const added = addGeneratedEntry(EMPTY_GENERATED_MANIFEST, key, blueprint);
    const parsed = parseGeneratedManifest(serializeGeneratedManifest(added));

    expect(parsed).toStrictEqual(added);
    expect(parsed.entries['blueprint:helpdesk']?.source).toStrictEqual(source);
    expect(parsed.entries['blueprint:helpdesk']?.migrations).toStrictEqual(blueprint.migrations);
    expect(serializeGeneratedManifest(parsed)).toBe(serializeGeneratedManifest(added));
  });

  it('refuses a blueprint key without a source or migrations', () => {
    const text = JSON.stringify({
      version: 1,
      entries: { 'blueprint:helpdesk': { files: {}, edits: [] } },
    });
    expect(refusedPaths(text)).toEqual([
      'entries.blueprint:helpdesk.source',
      'entries.blueprint:helpdesk.migrations',
    ]);
  });

  it('refuses a source or migrations on any other key', () => {
    const text = JSON.stringify({
      version: 1,
      entries: { 'resource:ticket': { ...ticket, source, migrations: {} } },
    });
    expect(refusedPaths(text)).toEqual([
      'entries.resource:ticket.source',
      'entries.resource:ticket.migrations',
    ]);
    expect(() =>
      addGeneratedEntry(EMPTY_GENERATED_MANIFEST, 'resource:ticket', { ...ticket, source }),
    ).toThrow('is carried only by a blueprint entry');
  });

  it('refuses a source with a range, a non-sha512 integrity or an unknown key', () => {
    const withSource = (patch: Record<string, unknown>): string =>
      JSON.stringify({
        version: 1,
        entries: { 'blueprint:helpdesk': { ...blueprint, source: { ...source, ...patch } } },
      });
    expect(refusedPaths(withSource({ version: '^1.2.0' }))).toEqual([
      'entries.blueprint:helpdesk.source.version',
    ]);
    expect(refusedPaths(withSource({ integrity: 'sha1-abc=' }))).toEqual([
      'entries.blueprint:helpdesk.source.integrity',
    ]);
    expect(refusedPaths(withSource({ url: 'https://registry.example' }))).toEqual([
      'entries.blueprint:helpdesk.source',
    ]);
  });

  it('refuses a migration mapped outside the project', () => {
    const text = JSON.stringify({
      version: 1,
      entries: {
        'blueprint:helpdesk': { ...blueprint, migrations: { 'migrations/0000_a.sql': '../a.sql' } },
      },
    });
    expect(refusedPaths(text)).toEqual([
      'entries.blueprint:helpdesk.migrations.migrations/0000_a.sql',
    ]);
  });
});
