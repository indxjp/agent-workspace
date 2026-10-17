import { ApiProblemError, ContractViolationError, TransportError } from '@indx-workspace/sdk';
import { describe, expect, it } from 'vitest';

import {
  editedInUiProblem,
  formatProblem,
  missingFolders,
  problemCount,
  problemsFromError,
  withMissingFolderHint,
} from './problems.js';

function apiProblem(
  status: number,
  code: string,
  details: readonly string[] = [],
): ApiProblemError {
  return new ApiProblemError({ status, problem: { code, message: `refused: ${code}`, details } });
}

describe('formatProblem', () => {
  it('prints a located problem as a clickable path:line:column', () => {
    expect(
      formatProblem({
        file: 'surfaces/main.ts',
        status: null,
        code: 'module_failed',
        details: ["Expected ',', got 'ident'"],
        location: { file: 'surfaces/main.ts', line: 12, column: 9 },
      }),
    ).toBe("✗ surfaces/main.ts:12:9  Expected ',', got 'ident'");
  });

  it('names the definition when the location is in another file', () => {
    expect(
      formatProblem({
        file: 'agents/one.ts',
        status: null,
        code: 'module_failed',
        details: ['the tool broke'],
        location: { file: 'tools/orders.ts', line: 1, column: 7 },
      }),
    ).toBe('✗ tools/orders.ts:1:7  the tool broke (loading agents/one.ts)');
  });

  it('prints the status, or local, the code and the details', () => {
    expect(
      formatProblem({
        file: 'agents/assistant.ts',
        status: 422,
        code: 'engine_capability_unsupported',
        details: ['mcp'],
      }),
    ).toBe('agents/assistant.ts: 422 engine_capability_unsupported [mcp]');
    expect(
      formatProblem({ file: 'agents/assistant.ts', status: 403, code: 'forbidden', details: [] }),
    ).toBe('agents/assistant.ts: 403 forbidden');
    expect(
      formatProblem({
        file: 'surfaces/main.ts',
        status: null,
        code: 'import_refused',
        details: ['node:fs', 'lodash'],
      }),
    ).toBe('surfaces/main.ts: local import_refused [node:fs, lodash]');
  });

  it('appends a hint after the details, and only when there is one', () => {
    expect(
      formatProblem({
        file: 'agents/assistant.ts',
        status: null,
        code: 'edited_in_ui',
        details: ['x'],
        hint: 'do this',
      }),
    ).toBe('agents/assistant.ts: local edited_in_ui [x]; do this');
    expect(
      formatProblem({ file: 'agents/a.ts', status: null, code: 'c', details: [], hint: 'h' }),
    ).toBe('agents/a.ts: local c; h');
  });

  it('counts problems in words', () => {
    expect(problemCount(1)).toBe('1 problem');
    expect(problemCount(2)).toBe('2 problems');
  });
});

describe('problemsFromError', () => {
  it("attributes a server refusal to the agent's file", () => {
    expect(
      problemsFromError(apiProblem(422, 'engine_capability_unsupported', ['mcp']), 'agents/a.ts', [
        'surfaces/main.ts',
      ]),
    ).toEqual([
      { file: 'agents/a.ts', status: 422, code: 'engine_capability_unsupported', details: ['mcp'] },
    ]);
  });

  it("splits invalid_agent_version details between the agent's and the surfaces' files", () => {
    const error = apiProblem(400, 'invalid_agent_version', [
      'surfaces.1.theme: bad',
      'definition.agent.name: bad',
      'surfaces.0: bad',
      'surfaces.7.name: no such surface file',
    ]);
    expect(problemsFromError(error, 'agents/a.ts', ['surfaces/x.ts', 'surfaces/y.ts'])).toEqual([
      {
        file: 'surfaces/y.ts',
        status: 400,
        code: 'invalid_agent_version',
        details: ['surfaces.1.theme: bad'],
      },
      {
        file: 'agents/a.ts',
        status: 400,
        code: 'invalid_agent_version',
        details: ['definition.agent.name: bad', 'surfaces.7.name: no such surface file'],
      },
      {
        file: 'surfaces/x.ts',
        status: 400,
        code: 'invalid_agent_version',
        details: ['surfaces.0: bad'],
      },
    ]);
  });

  it('rethrows transport and contract failures, which no file can fix', () => {
    const transport = new TransportError({
      operation: 'agents.list',
      aborted: false,
      cause: new Error('down'),
    });
    expect(() => problemsFromError(transport, 'agents/a.ts', [])).toThrow(transport);
    const contract = new ContractViolationError({
      operation: 'agents.list',
      status: 200,
      issues: ['agents: expected array'],
    });
    expect(() => problemsFromError(contract, 'agents/a.ts', [])).toThrow(contract);
    const plain = new Error('boom');
    expect(() => problemsFromError(plain, 'agents/a.ts', [])).toThrow(plain);
  });
});

describe('withMissingFolderHint (#899)', () => {
  const refusal = (details: readonly string[]) => ({
    file: 'agents/reviewer.ts',
    status: 422,
    code: 'agent_definition_references_missing',
    details,
  });

  it('says to upload a file into every folder a refusal names', () => {
    const problem = refusal(['file:playbook', 'file:contracts']);
    expect(missingFolders(problem)).toEqual(['playbook', 'contracts']);
    expect(formatProblem(withMissingFolderHint(problem))).toBe(
      'agents/reviewer.ts: 422 agent_definition_references_missing [file:playbook, file:contracts]; ' +
        'upload a file into playbook, contracts (aw files upload <folder>/<name> <local-file>), ' +
        'then save again or run aw push --yes',
    );
  });

  it('leaves a refusal alone when a detail is not a folder, or the code is another', () => {
    const mixed = refusal(['skill:refunds', 'file:playbook']);
    expect(missingFolders(mixed)).toBeUndefined();
    expect(withMissingFolderHint(mixed)).toBe(mixed);
    const other = { ...refusal(['file:playbook']), code: 'invalid_agent_version' };
    expect(withMissingFolderHint(other)).toBe(other);
    const empty = refusal([]);
    expect(withMissingFolderHint(empty)).toBe(empty);
  });
});

describe('editedInUiProblem (issue #546)', () => {
  it('names the edit and the local pointer it came after, and how to overwrite it', () => {
    const problem = editedInUiProblem('agents/assistant.ts', {
      name: 'assistant',
      agentUpdatedAt: '2026-10-03T00:00:00.000Z',
      pointer: { number: 1, updatedAt: '2026-10-02T10:00:00.000Z' },
    });
    expect(problem).toEqual({
      file: 'agents/assistant.ts',
      status: null,
      code: 'edited_in_ui',
      details: [
        '"assistant" edited 2026-10-03T00:00:00.000Z',
        'local 1 set 2026-10-02T10:00:00.000Z',
      ],
      hint: 'run `aw push --yes` to overwrite it with this file',
    });
    expect(formatProblem(problem)).toBe(
      'agents/assistant.ts: local edited_in_ui ["assistant" edited 2026-10-03T00:00:00.000Z, ' +
        'local 1 set 2026-10-02T10:00:00.000Z]; run `aw push --yes` to overwrite it with this file',
    );
  });

  it('says an agent made outside aw has no local pointer', () => {
    expect(
      formatProblem(editedInUiProblem('agents/helper.ts', { name: 'helper', pointer: null })),
    ).toBe(
      'agents/helper.ts: local edited_in_ui ["helper" has no local pointer]; ' +
        'run `aw push --yes` to overwrite it with this file',
    );
  });
});
