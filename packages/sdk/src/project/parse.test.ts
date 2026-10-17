import { describe, expect, it } from 'vitest';

import { parseProjectFile, readEvalCaseFile } from './parse.js';
import { ProjectFileError } from './reader.js';

const v2 = `apiVersion: agentworkspace.dev/v2
kind: Project
name: my-project
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
`;

function refusal(text: string): ProjectFileError {
  try {
    parseProjectFile(text);
  } catch (thrown) {
    if (thrown instanceof ProjectFileError) return thrown;
    throw thrown;
  }
  throw new Error('expected a ProjectFileError');
}

describe('parseProjectFile', () => {
  it('returns a frozen result holding a frozen project', () => {
    const result = parseProjectFile(v2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.project)).toBe(true);
  });

  it('accepts a v2 project file as written', () => {
    expect(parseProjectFile(v2)).toEqual({
      lifted: false,
      project: {
        apiVersion: 'agentworkspace.dev/v2',
        kind: 'Project',
        name: 'my-project',
        environments: {
          local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } },
        },
      },
    });
  });

  it('lifts a v1 deployment profile', () => {
    const read = parseProjectFile(
      'apiVersion: agentworkspace.dev/v1\n' +
        'kind: Deployment\n' +
        'cloud: gcp\n' +
        'storage:\n' +
        '  relational: cloud-sql\n' +
        '  objects: gs://acme\n' +
        '  secrets: gcp-kms\n' +
        'runtime:\n' +
        '  default: cloud-run-service\n' +
        'identity:\n' +
        '  bootstrapAdmin: ops@acme.example\n',
    );
    expect(read).toMatchObject({
      lifted: true,
      project: { environments: { production: { cloud: 'gcp' } } },
    });
  });

  it('refuses an unknown key at the key itself, naming its path', () => {
    const error = refusal(
      v2.replace('    cloud: local\n', '    cloud: local\n    storage:\n      secrets: x\n'),
    );
    expect(error.path).toBe('environments.local.storage');
    expect({ line: error.line, column: error.column }).toEqual({ line: 7, column: 5 });
    expect(error.message).toMatch(
      /^agent-workspace\.yaml line 7, column 5: environments\.local\.storage /u,
    );
  });

  it('refuses an unknown platform at its own key, naming the platform ids', () => {
    const error = refusal(`${v2}platforms:\n  copilot:\n    enabled: true\n`);
    expect(error.path).toBe('platforms.copilot');
    expect({ line: error.line, column: error.column }).toEqual({ line: 10, column: 3 });
    expect(error.message).toMatch(
      /^agent-workspace\.yaml line 10, column 3: platforms\.copilot is not a platform; /u,
    );
  });

  it('refuses a wrong value at its own line', () => {
    const error = refusal(v2.replace('cloud: local', 'cloud: aws'));
    expect(error.path).toBe('environments.local.cloud');
    expect({ line: error.line, column: error.column }).toEqual({ line: 6, column: 5 });
  });

  it.each([
    [4000, 'gateway'],
    [8080, 'runner'],
  ])(
    'refuses the reserved local port %i at its line, naming the %s (issue #560)',
    (port, service) => {
      const error = refusal(`${v2}    port: ${String(port)}\n`);
      expect(error.path).toBe('environments.local.port');
      expect({ line: error.line, column: error.column }).toEqual({ line: 9, column: 5 });
      expect(error.message).toBe(
        `agent-workspace.yaml line 9, column 5: environments.local.port is reserved by the local runtime's ${service} (${String(port)}); choose another port`,
      );
    },
  );

  it('accepts a local port the runtime does not reserve', () => {
    expect(parseProjectFile(`${v2}    port: 3001\n`).project).toMatchObject({
      environments: { local: { port: 3001 } },
    });
  });

  it('refuses an unknown apiVersion at its line', () => {
    const error = refusal(v2.replace('/v2', '/v9'));
    expect(error.path).toBe('apiVersion');
    expect(error.line).toBe(1);
  });

  it('passes a reader refusal through unchanged', () => {
    const error = refusal(`${v2}name: again\n`);
    expect(error.path).toBeUndefined();
    expect(error.message).toMatch(/^agent-workspace\.yaml line 9, column 1: duplicate key "name"/u);
  });
});

describe('readEvalCaseFile (issue #618)', () => {
  const label = 'evals/support.yaml';
  const demo = `cases:
  - name: order status uses the tool
    input: "Where is order 1042?"
    expect: { tool: orders_getOrder, contains: ["shipped"] }
  - name: no refund promises
    input: "I want my money back now"
    expect: { judge: "Stays polite and does not promise a refund" }
`;

  function evalRefusal(text: string): ProjectFileError {
    try {
      readEvalCaseFile(text, label);
    } catch (thrown) {
      if (thrown instanceof ProjectFileError) return thrown;
      throw thrown;
    }
    throw new Error('expected a refusal');
  }

  it("reads the issue's demo file", () => {
    expect(readEvalCaseFile(demo, label).cases).toEqual([
      {
        name: 'order status uses the tool',
        input: 'Where is order 1042?',
        expect: { tool: 'orders_getOrder', contains: ['shipped'] },
      },
      {
        name: 'no refund promises',
        input: 'I want my money back now',
        expect: { judge: 'Stays polite and does not promise a refund' },
      },
    ]);
  });

  it('names the file, the line and the column of an unknown check', () => {
    const error = evalRefusal(demo.replace('{ judge:', '{ score: 1, judge:'));
    expect(error.path).toBe('cases.1.expect.score');
    expect(error.message).toMatch(
      /^evals\/support\.yaml line 7, column 15: cases\.1\.expect\.score /u,
    );
  });

  it('refuses an alias, naming the file it is in', () => {
    const error = evalRefusal(`cases:
  - name: a
    input: &prompt hi
    expect: { contains: [hi] }
  - name: b
    input: *prompt
    expect: { contains: [hi] }
`);
    expect(error.message).toMatch(
      /^evals\/support\.yaml line 3, column 12: an anchor is not accepted in evals\/support\.yaml/u,
    );
  });

  it('takes 200 cases and refuses 201 (issue #799)', () => {
    const line = (index: number) =>
      `  - { name: c${String(index)}, input: hi, expect: { contains: [hi] } }\n`;
    const file = (count: number) =>
      `cases:\n${Array.from({ length: count }, (_, index) => line(index)).join('')}`;
    expect(readEvalCaseFile(file(200), 'evals/support.yaml').cases).toHaveLength(200);
    expect(evalRefusal(file(201)).path).toBe('cases');
  });

  it('reads a toolInput beside its tool (issue #799)', () => {
    const parsed = readEvalCaseFile(
      'cases:\n  - { name: a, input: hi, expect: { tool: t, toolInput: { id: "1" } } }\n',
      'evals/support.yaml',
    );
    expect(parsed.cases[0]?.expect.toolInput).toEqual({ id: '1' });
  });
});
