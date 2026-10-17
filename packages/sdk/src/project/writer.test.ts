import { describe, expect, it } from 'vitest';

import { ProjectRenderError } from './errors.js';
import { parseProjectFile, readEvalCaseFile } from './parse.js';
import { readProjectFileText } from './reader.js';
import { writeProjectFileText, type ProjectFileMapping } from './writer.js';

const read = (text: string): unknown => readProjectFileText(text).value;

describe('writeProjectFileText', () => {
  it('round-trips what it writes', () => {
    const document: ProjectFileMapping = {
      cloud: 'gcp',
      storage: { relational: 'cloud-sql', objects: 's3://acme-ai-files', secrets: 'local-key' },
      identity: { oidc: 'https://accounts.google.com', bootstrapAdmin: 'ops@acme.example' },
    };
    expect(read(writeProjectFileText(document))).toEqual(document);
  });

  it('quotes a value the plain form would read back differently, and reads it again', () => {
    for (const value of [
      'has # hash',
      "it's quoted",
      '  padded  ',
      '#leading',
      '[bracket',
      '{brace',
      '*star',
      '&amp',
      '!bang',
      '%pct',
      '@at',
      '',
      ': colon',
      'key: value',
      '- item',
      'true',
      'null',
      '~',
      '1.0',
      '0x1',
      '12',
      'line\nbreak',
    ]) {
      const written = writeProjectFileText({ storage: { objects: value } });
      expect(read(written), JSON.stringify(value)).toEqual({ storage: { objects: value } });
    }
  });

  it('writes a value plain when the core schema reads it back as the same text', () => {
    expect(writeProjectFileText({ cloud: 'gcp', storage: { secrets: 'yes' } })).toBe(
      'cloud: gcp\nstorage:\n  secrets: yes\n',
    );
    expect(writeProjectFileText({ cloud: 'true' })).toBe("cloud: 'true'\n");
  });

  it('writes the header as comments', () => {
    expect(writeProjectFileText({ cloud: 'local' }, ['first', '', 'last'])).toBe(
      '# first\n#\n# last\ncloud: local\n',
    );
  });

  it('writes deeper mappings at two spaces a level', () => {
    expect(
      writeProjectFileText({
        name: 'my-project',
        environments: {
          local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } },
        },
      }),
    ).toBe(
      'name: my-project\n' +
        'environments:\n' +
        '  local:\n' +
        '    cloud: local\n' +
        '    identity:\n' +
        '      bootstrapAdmin: admin@localhost.test\n',
    );
  });

  it('writes an integer plain, and it reads back as a number', () => {
    const written = writeProjectFileText({ environments: { local: { port: 3000 } } });
    expect(written).toBe('environments:\n  local:\n    port: 3000\n');
    expect(read(written)).toEqual({ environments: { local: { port: 3000 } } });
  });

  it.each([
    [Number.NaN, 'must be a finite number'],
    [Number.POSITIVE_INFINITY, 'must be a finite number'],
    [Number.NEGATIVE_INFINITY, 'must be a finite number'],
    [2 ** 60, 'must be a safe integer'],
  ])('refuses the number %s, which does not read back the same', (port, message) => {
    let thrown: unknown;
    try {
      writeProjectFileText({ environments: { local: { port } } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectRenderError);
    expect(thrown).toMatchObject({ issues: [{ path: 'environments.local.port', message }] });
  });

  it('writes a finite decimal plain, and it reads back as the same number', () => {
    const document = { limits: { maxBudgetUsd: 0.5, ratio: 1.5, tiny: 1e-7, negative: -2.25 } };
    const written = writeProjectFileText(document);
    expect(written).toBe(
      'limits:\n  maxBudgetUsd: 0.5\n  ratio: 1.5\n  tiny: 1e-7\n  negative: -2.25\n',
    );
    expect(read(written)).toStrictEqual(document);
  });

  it('writes a boolean plain, and it reads back as a boolean', () => {
    const written = writeProjectFileText({ permissions: { readFiles: true, runCommands: false } });
    expect(written).toBe('permissions:\n  readFiles: true\n  runCommands: false\n');
    expect(read(written)).toStrictEqual({ permissions: { readFiles: true, runCommands: false } });
  });

  it('writes a list as a block sequence, and an empty one as []', () => {
    const written = writeProjectFileText({
      policy: { engines: ['claude-agent-sdk', 'openai-agents'], tools: [] },
    });
    expect(written).toBe(
      'policy:\n  engines:\n    - claude-agent-sdk\n    - openai-agents\n  tools: []\n',
    );
    expect(read(written)).toStrictEqual({
      policy: { engines: ['claude-agent-sdk', 'openai-agents'], tools: [] },
    });
  });

  it('quotes a list item that would read back as something else, and keeps numbers typed', () => {
    const items = ['true', '- x', '1', 'a: b', '', 'plain', 1, 0.5, false];
    const written = writeProjectFileText({ items });
    expect(written).toBe(
      "items:\n  - 'true'\n  - '- x'\n  - '1'\n  - 'a: b'\n  - ''\n  - plain\n  - 1\n  - 0.5\n  - false\n",
    );
    expect(read(written)).toStrictEqual({ items });
  });

  it('quotes a key the plain form would read back differently', () => {
    const written = writeProjectFileText({ true: 'yes', '1': 'one', 'a: b': { c: 'd' } });
    expect(written).toBe("'1': one\n'true': yes\n'a: b':\n  c: d\n");
    expect(read(written)).toEqual({ '1': 'one', true: 'yes', 'a: b': { c: 'd' } });
  });

  /** The ProjectRenderError `write` throws, so its issues can be compared. */
  function writeError(write: () => unknown): ProjectRenderError {
    try {
      write();
    } catch (error) {
      if (error instanceof ProjectRenderError) return error;
      throw error;
    }
    throw new Error('expected a ProjectRenderError');
  }

  /** A value outside `ProjectFileMapping`, as an untyped JavaScript caller can pass one. */
  const untyped = (value: unknown): ProjectFileMapping => value as ProjectFileMapping;

  it.each([
    ['a bigint', 1n],
    ['null', null],
    ['undefined', undefined],
    ['a date', new Date(0)],
  ])('refuses %s as a value, naming its dotted path', (_kind, value) => {
    const error = writeError(() => writeProjectFileText(untyped({ storage: { objects: value } })));
    expect(error.issues).toStrictEqual([
      {
        path: 'storage.objects',
        message: 'must be text, a number, a boolean, a list of those or a non-empty mapping',
      },
    ]);
  });

  it.each([
    ['a list', ['x']],
    ['an empty mapping', {}],
    ['null', null],
    ['a bigint', 1n],
  ])('refuses %s as a list item, naming its index', (_kind, item) => {
    const error = writeError(() => writeProjectFileText(untyped({ policy: { tools: [item] } })));
    expect(error.issues).toStrictEqual([
      {
        path: 'policy.tools.0',
        message: 'a list item must be text, a number, a boolean or a non-empty mapping',
      },
    ]);
  });

  it('writes a list of mappings that an eval case file reads back unchanged (issue #620)', () => {
    const file = {
      cases: [
        { name: 'order status', input: 'Where is order 1042?', expect: { contains: ['shipped'] } },
        {
          name: 'run 44444444',
          input: 'Line one\nline two: "quoted" # not a comment',
          expect: { judge: "Must not repeat: it's 'fine'" },
          fromRun: '44444444-4444-4444-8444-444444444444',
        },
      ],
    };
    const text = writeProjectFileText(file);
    expect(text).toContain('cases:\n  - name: order status\n    input: Where is order 1042?\n');
    expect(readEvalCaseFile(text, 'evals/support.yaml')).toEqual(file);
  });

  it('writes an eval case with a toolInput that reads back unchanged (issue #799)', () => {
    const file = {
      cases: [
        {
          name: 'lookup',
          input: 'Where is order 1042?',
          expect: {
            tool: 'orders_getOrder',
            toolInput: { orderNumber: '1042', opts: { ids: [1, 2] } },
          },
        },
      ],
    };
    expect(readEvalCaseFile(writeProjectFileText(file), 'evals/support.yaml')).toEqual(file);
  });

  it('refuses a bad value inside a list item at its path', () => {
    const error = writeError(() => writeProjectFileText(untyped({ cases: [{ a: null }] })));
    expect(error.issues).toStrictEqual([
      {
        path: 'cases.0.a',
        message: 'must be text, a number, a boolean, a list of those or a non-empty mapping',
      },
    ]);
  });

  it('refuses a list item that is not a finite number at its index', () => {
    const error = writeError(() => writeProjectFileText({ a: ['x', Number.NaN] }));
    expect(error.issues).toStrictEqual([{ path: 'a.1', message: 'must be a finite number' }]);
  });

  it('round-trips a v2 project with models, connectors and policy through parseProjectFile', () => {
    const project: ProjectFileMapping = {
      apiVersion: 'agentworkspace.dev/v2',
      kind: 'Project',
      name: 'support-desk',
      engine: 'claude-agent-sdk',
      models: {
        default: { provider: 'anthropic', credential: { secret: 'ANTHROPIC_API_KEY' } },
      },
      connectors: {
        github: {
          url: 'https://mcp.example.com/mcp',
          auth: { scheme: 'bearer', credential: { secret: 'GITHUB_TOKEN' } },
        },
      },
      policy: {
        permissions: { runCommands: false },
        limits: { maxBudgetUsd: 2.5 },
        engines: ['claude-agent-sdk'],
        models: ['claude-sonnet-4-5'],
        tools: [],
        promotion: { minEvalScore: 0.9 },
      },
      environments: {
        local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } },
      },
    };
    const reading = parseProjectFile(writeProjectFileText(project));
    expect(reading.project).toStrictEqual(project);
  });

  it("writes an empty mapping as a key's value as {} and reads it back", () => {
    const text = writeProjectFileText(untyped({ storage: { runtime: {} } }));
    expect(text).toBe('storage:\n  runtime: {}\n');
    expect(read(text)).toStrictEqual({ storage: { runtime: {} } });
  });

  it.each([
    ['text', 'abc'],
    ['a list', ['a']],
    ['null', null],
  ])('refuses %s as the document', (_kind, document) => {
    const error = writeError(() => writeProjectFileText(untyped(document)));
    expect(error.issues).toStrictEqual([{ path: '(root)', message: 'must be a mapping' }]);
  });

  it.each([
    'first\nevil: injected',
    'carriage\rreturn',
    'tab\there',
    'next\u2028line',
    'nul\u0000',
  ])('refuses the header line %j, which would not stay a comment', (line) => {
    const error = writeError(() => writeProjectFileText({ a: 'b' }, ['fine', line]));
    expect(error.issues).toStrictEqual([
      { path: '(header).1', message: 'must be one line of text with no control character' },
    ]);
  });

  it('refuses a key longer than YAML reads back as an implicit key', () => {
    const key = 'k'.repeat(1025);
    const error = writeError(() => writeProjectFileText({ a: { [key]: 'v' } }));
    expect(error.issues).toStrictEqual([
      { path: `a.${key}`, message: 'a key must be at most 1024 characters' },
    ]);
    const longest = { a: { ['k'.repeat(1024)]: 'v' } };
    expect(read(writeProjectFileText(longest))).toEqual(longest);
  });

  it('refuses mappings nested deeper than 32 levels', () => {
    let deep: ProjectFileMapping = { leaf: 'x' };
    for (let level = 0; level < 32; level += 1) deep = { a: deep };
    const error = writeError(() => writeProjectFileText(deep));
    expect(error.issues[0]?.message).toBe('must nest at most 32 mappings deep');
  });
});
