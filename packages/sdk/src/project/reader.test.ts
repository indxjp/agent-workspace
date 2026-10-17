import { describe, expect, it } from 'vitest';

import { ProjectFileError, readProjectFileText } from './reader.js';

const valid = `# a comment
cloud: gcp
storage:
  relational: cloud-sql            # rds | cloud-sql | azure-postgres
  objects:    s3://acme-ai-files
  secrets:    local-key
runtime:
  default: cloud-run-service
identity:
  oidc: https://accounts.google.com
  bootstrapAdmin: ops@acme.example
`;

const read = (text: string): unknown => readProjectFileText(text).value;

function refusal(text: string): ProjectFileError {
  try {
    readProjectFileText(text);
  } catch (thrown) {
    if (thrown instanceof ProjectFileError) return thrown;
    throw thrown;
  }
  throw new Error('expected a ProjectFileError');
}

describe('readProjectFileText', () => {
  it.each([
    ['flow', `${'['.repeat(5000)}${']'.repeat(5000)}`, 1, 33],
    [
      'block',
      Array.from({ length: 3000 }, (_, level) => `${' '.repeat(level)}a:`).join('\n'),
      33,
      33,
    ],
  ])(
    'refuses %s collections nested past 32 levels at the first one too deep',
    (_style, text, line, column) => {
      const error = refusal(text);
      expect(error.message).toContain('may nest at most 32 levels deep');
      expect({ line: error.line, column: error.column }).toStrictEqual({ line, column });
    },
  );

  it('reads collections nested exactly 32 levels deep', () => {
    expect(read(`${'['.repeat(32)}${']'.repeat(32)}`)).toBeDefined();
  });

  it('reads a two-level mapping, trailing comments and aligned values', () => {
    expect(read(valid)).toEqual({
      cloud: 'gcp',
      storage: {
        relational: 'cloud-sql',
        objects: 's3://acme-ai-files',
        secrets: 'local-key',
      },
      runtime: { default: 'cloud-run-service' },
      identity: { oidc: 'https://accounts.google.com', bootstrapAdmin: 'ops@acme.example' },
    });
  });

  it('reads a mapping nested four levels deep, and locates its deepest key', () => {
    const text =
      'apiVersion: agentworkspace.dev/v2\n' +
      'environments:\n' +
      '  local:\n' +
      '    cloud: local\n' +
      '    identity:\n' +
      '      bootstrapAdmin: admin@localhost.test\n';
    const reading = readProjectFileText(text);
    expect(reading.value).toEqual({
      apiVersion: 'agentworkspace.dev/v2',
      environments: {
        local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } },
      },
    });
    expect(reading.locate(['environments', 'local', 'identity', 'bootstrapAdmin'])).toEqual({
      line: 6,
      column: 7,
    });
    expect(reading.locate(['environments', 'local', 'identity', 'oidc'])).toEqual({
      line: 5,
      column: 5,
    });
  });

  it('keeps a connection string with a colon and a slash as one plain scalar', () => {
    const url = 'postgres://agent_workspace:s3cr3t@postgres:5432/agent_workspace';
    expect(read(`storage:\n  relational: ${url}\n`)).toEqual({ storage: { relational: url } });
  });

  it('accepts CRLF line endings', () => {
    expect(read('cloud: local\r\nruntime:\r\n  default: docker\r\n')).toEqual({
      cloud: 'local',
      runtime: { default: 'docker' },
    });
  });

  it('reads the YAML an older subset refused, leaving its shape to the schema', () => {
    expect(read('cloud: "local"\nruntime: { default: docker }\n')).toEqual({
      cloud: 'local',
      runtime: { default: 'docker' },
    });
    expect(read('runtime:\n    default: docker\n')).toEqual({ runtime: { default: 'docker' } });
    expect(read('storage:\n  - one\n')).toEqual({ storage: ['one'] });
    expect(read('cloud: !!str local\n')).toEqual({ cloud: 'local' });
    expect(read('cloud:  # decided later\n')).toEqual({ cloud: null });
    expect(read('')).toBeNull();
    expect(read('# only a comment\n')).toBeNull();
  });

  it('keeps a key named __proto__ as a key, never as a prototype', () => {
    const value = read('__proto__:\n  polluted: yes\n');
    expect(Object.keys(value ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  // Each of these is YAML a reader could resolve more than one way, or that the parser itself
  // reports. Refusing it by line and column is the whole point: a reader that guessed would point
  // an environment at the wrong store.
  it.each([
    ['an anchor', 'cloud: local\nstorage: &shared\n  objects: x\n', 2, 10, /an anchor/u],
    ['an anchor on a scalar', 'cloud: &c local\n', 1, 8, /an anchor/u],
    ['an alias', 'cloud: local\nruntime: *c\n', 2, 10, /an alias/u],
    ['a local tag', 'cloud: !aws local\n', 1, 8, /the tag !aws/u],
    ['a non-core standard tag', 'cloud: !!binary bG9jYWw=\n', 1, 8, /the tag !!binary/u],
    ['a %TAG directive', '%TAG !e! tag:example.com,2026:\n---\ncloud: local\n', 1, 1, /directive/u],
    ['a %YAML directive', '%YAML 1.2\n---\ncloud: local\n', 1, 1, /directive/u],
    ['a duplicate top-level key', 'cloud: local\ncloud: aws\n', 2, 1, /duplicate key "cloud"/u],
    ['a duplicate nested key', 'a:\n  b: 1\n  b: 2\n', 3, 3, /duplicate key "b"/u],
    ['a second document', 'cloud: local\n---\ncloud: aws\n', 2, 1, /second document/u],
    ['an empty second document', 'cloud: local\n---\n', 2, 1, /second document/u],
    ['a tab in indentation', 'storage:\n\trelational: x\n', 2, 1, /tab/iu],
    ['an unterminated flow sequence', 'cloud: local\nstorage: [one\n', 3, 1, /flow sequence/iu],
    // The parser names where the closing quote is missing: the end of the file.
    ['an unterminated quote', "cloud: 'local\n", 2, 1, /quote/iu],
    ['a key that is not text', 'cloud: local\n1: one\n', 2, 1, /key must be text/u],
    ['a mapping as a key', '? { a: b }\n: c\n', 1, 3, /key must be text/u],
  ])('refuses %s, naming its line and column', (_case, text, line, column, expected) => {
    const error = refusal(text);
    expect(error.message).toMatch(expected);
    expect({ line: error.line, column: error.column }).toEqual({ line, column });
    expect(error.message).toMatch(
      new RegExp(`^agent-workspace\\.yaml line ${line}, column ${column}: `, 'u'),
    );
    expect(error.name).toBe('ProjectFileError');
    expect(error.path).toBeUndefined();
  });

  it('reports the earliest problem when a file has several', () => {
    const error = refusal('cloud: local\nstorage: &a\n  objects: x\ncloud: aws\n---\n');
    expect(error.line).toBe(2);
    expect(error.message).toMatch(/an anchor/u);

    const duplicate = refusal('cloud: local\ncloud: aws\nruntime: !custom x\n');
    expect(duplicate.line).toBe(2);
    expect(duplicate.message).toMatch(/duplicate key "cloud"/u);
  });

  it('locates the deepest key a dotted path names, or the start of the document', () => {
    const { locate } = readProjectFileText(
      '# header\ncloud: gcp\nstorage:\n  relational: cloud-sql\n    # aside\n  objects: x\n',
    );
    expect(locate(['cloud'])).toEqual({ line: 2, column: 1 });
    expect(locate(['storage', 'objects'])).toEqual({ line: 6, column: 3 });
    expect(locate(['storage', 'secrets'])).toEqual({ line: 3, column: 1 });
    expect(locate(['identity', 'bootstrapAdmin'])).toEqual({ line: 2, column: 1 });
    expect(readProjectFileText('').locate(['cloud'])).toEqual({ line: 1, column: 1 });
  });
});
