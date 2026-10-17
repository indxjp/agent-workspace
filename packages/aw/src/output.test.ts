import {
  ApiProblemError,
  ContractViolationError,
  InvalidArgumentError,
  TransportError,
} from '@indx-workspace/sdk';
import { describe, expect, it } from 'vitest';

import {
  CommandRefusedError,
  PlatformFieldsDroppedError,
  RunFailedError,
  UsageError,
  type CliIo,
} from './io.js';
import {
  EXIT_CODE,
  renderHuman,
  renderRecord,
  renderTable,
  reportFailure,
  writeResult,
} from './output.js';

function collectingIo(): {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
} {
  let out = '';
  let err = '';
  return {
    io: {
      stdin: () => Promise.resolve(''),
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      env: {},
      homeDir: '',
      fetch: () => Promise.reject(new Error('no network')),
      isTty: false,
    },
    out: () => out,
    err: () => err,
  };
}

const MODE = { json: false, jsonl: false, raw: false, quiet: false };

describe('renderTable / renderRecord / renderHuman', () => {
  it('aligns columns, renders null as blank and objects as JSON, and never pads the last column', () => {
    const text = renderTable(
      [
        { id: 'a', name: 'Alpha', archivedAt: null, extra: { n: 1 } },
        { id: 'bb', name: 'B', archivedAt: '2026-09-21T00:00:00.000Z', extra: [1] },
      ],
      ['id', 'name', 'archivedAt', 'extra'],
    );
    expect(text).toBe(
      [
        'id  name   archivedAt                extra',
        '--  -----  ------------------------  -------',
        'a   Alpha                            {"n":1}',
        'bb  B      2026-09-21T00:00:00.000Z  [1]',
      ].join('\n'),
    );
  });

  it('renders one resource as field/value lines', () => {
    expect(renderRecord({ id: 'x', publicSharing: true })).toBe(
      'id             x\npublicSharing  true',
    );
  });

  it('renders scalars one per line, an empty listing as (none), and nothing for undefined', () => {
    expect(renderHuman(['a', 'b'], undefined)).toBe('a\nb');
    expect(renderHuman([], undefined)).toBe('(none)');
    expect(renderHuman(undefined, undefined)).toBe('');
    expect(renderHuman(7, undefined)).toBe('7');
  });
});

describe('writeResult', () => {
  it('prints exactly the value as JSON with --json and one row per line with --jsonl', () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const a = collectingIo();
    writeResult(a.io, { ...MODE, json: true }, rows);
    expect(JSON.parse(a.out())).toEqual(rows);
    const b = collectingIo();
    writeResult(b.io, { ...MODE, jsonl: true }, rows);
    expect(b.out()).toBe('{"id":1}\n{"id":2}\n');
    const c = collectingIo();
    writeResult(c.io, { ...MODE, json: true }, undefined);
    expect(c.out()).toBe('');
    const d = collectingIo();
    writeResult(d.io, { ...MODE, jsonl: true }, { runs: rows, nextCursor: null });
    expect(d.out()).toBe('{"runs":[{"id":1},{"id":2}],"nextCursor":null}\n');
  });
});

describe('reportFailure', () => {
  it('names ANTHROPIC_API_KEY for a missing or rejected model key (#661)', () => {
    const refused = collectingIo();
    reportFailure(
      refused.io,
      new ApiProblemError({
        status: 422,
        problem: { code: 'model_connection_unresolved', message: 'No model.', details: [] },
      }),
      false,
    );
    expect(refused.err()).toContain('fix: on aw dev, set ANTHROPIC_API_KEY');
    const failed = collectingIo();
    reportFailure(failed.io, new RunFailedError('r1', 'model_credential_rejected', 'x'), false);
    expect(failed.err()).toContain('restart aw dev');
    const other = collectingIo();
    reportFailure(other.io, new RunFailedError('r1', 'model_unavailable', 'x'), false);
    expect(other.err()).not.toContain('fix:');
  });

  it("points aw dev's key, refused an admin task, at the console's API keys page (BH061-017)", () => {
    const refused = collectingIo();
    reportFailure(
      refused.io,
      new ApiProblemError({
        status: 403,
        problem: { code: 'local_runtime_key_not_permitted', message: 'No.', details: [] },
      }),
      false,
    );
    expect(refused.err()).toContain('fix: sign in to aw dev');
    expect(refused.err()).toContain('(/admin/api-keys)');
  });

  it('gives a provider that cannot be connected to a reachability hint, not the key (#661)', () => {
    const refused = collectingIo();
    reportFailure(
      refused.io,
      new ApiProblemError({
        status: 422,
        problem: { code: 'model_connection_failed', message: 'Connection refused.', details: [] },
      }),
      false,
    );
    expect(refused.err()).toContain("fix: check the model connection's base URL");
    expect(refused.err()).not.toContain('ANTHROPIC_API_KEY');
    const failed = collectingIo();
    reportFailure(failed.io, new RunFailedError('r1', 'model_connection_failed', 'x'), false);
    expect(failed.err()).toContain('(network, proxy, DNS)');
    expect(failed.err()).not.toContain('ANTHROPIC_API_KEY');
  });

  it('maps every failure class to its exit code and message', () => {
    const problem = collectingIo();
    expect(
      reportFailure(
        problem.io,
        new ApiProblemError({
          status: 404,
          problem: { code: 'agent_not_found', message: 'No such agent.', details: ['id'] },
        }),
        false,
      ),
    ).toBe(EXIT_CODE.problem);
    expect(problem.err()).toBe('error: agent_not_found: No such agent.\n  id\n');

    const usage = collectingIo();
    expect(reportFailure(usage.io, new UsageError('missing <id>'), false)).toBe(EXIT_CODE.usage);
    expect(usage.err()).toContain('error: missing <id>');

    const contract = collectingIo();
    expect(
      reportFailure(
        contract.io,
        new ContractViolationError({
          operation: 'agents.list',
          status: 200,
          issues: ['agents: expected array'],
        }),
        false,
      ),
    ).toBe(EXIT_CODE.contract);
    expect(contract.err()).toContain('error: contract_violation: agents.list');

    const transport = collectingIo();
    expect(
      reportFailure(
        transport.io,
        new TransportError({
          operation: 'agents.list',
          aborted: false,
          cause: new Error('ECONNREFUSED'),
        }),
        false,
      ),
    ).toBe(EXIT_CODE.transport);
    expect(transport.err()).toBe(
      'error: transport: agents.list: the request could not be completed (ECONNREFUSED)\n',
    );

    // BH061-040: against a local runtime, say what is most likely wrong.
    const local = collectingIo();
    reportFailure(
      local.io,
      new TransportError({ operation: 'agents.list', aborted: false, cause: new Error('x') }),
      false,
      'http://127.0.0.1:3000',
    );
    expect(local.err()).toContain(
      'fix: nothing answers at http://127.0.0.1:3000: start the local runtime with npm run dev (aw dev)\n',
    );

    const interrupted = collectingIo();
    expect(
      reportFailure(
        interrupted.io,
        new TransportError({
          operation: 'runs.follow',
          aborted: true,
          cause: new Error('aborted'),
        }),
        true,
      ),
    ).toBe(EXIT_CODE.interrupted);
    expect(interrupted.err()).toBe('interrupted\n');

    const timeout = collectingIo();
    expect(
      reportFailure(
        timeout.io,
        new TransportError({ operation: 'runs.get', aborted: true, cause: new Error('timeout') }),
        false,
      ),
    ).toBe(EXIT_CODE.transport);

    const unexpected = collectingIo();
    expect(reportFailure(unexpected.io, new RangeError('boom'), false)).toBe(EXIT_CODE.problem);
    expect(unexpected.err()).toBe('error: unexpected: boom\n');
  });
});

describe('reportFailure: an argument the SDK refused (issue #496)', () => {
  it('is a usage error that names the refused value, not an unexpected failure', () => {
    const refused = collectingIo();
    expect(
      reportFailure(
        refused.io,
        new InvalidArgumentError({ code: 'invalid_path_segment', value: '..' }),
        false,
      ),
    ).toBe(EXIT_CODE.usage);
    expect(refused.err()).toBe(
      'error: a path segment must not be empty, "." or ".." or hold a lone surrogate (got "..")\n' +
        'run "aw --help" for usage\n',
    );
    expect(refused.err()).not.toContain('unexpected');
    expect(refused.out()).toBe('');
  });

  it('is outranked by an interrupt, which still exits 130', () => {
    const interrupted = collectingIo();
    expect(
      reportFailure(
        interrupted.io,
        new InvalidArgumentError({ code: 'invalid_path_segment', value: '' }),
        true,
      ),
    ).toBe(EXIT_CODE.interrupted);
    expect(interrupted.err()).toBe('interrupted\n');
  });
});

describe('reportFailure: a refused command (issue #451)', () => {
  it('prints the message and the fix and exits 1', () => {
    const refused = collectingIo();
    expect(
      reportFailure(refused.io, new CommandRefusedError('no project here', 'aw init --yes'), false),
    ).toBe(EXIT_CODE.problem);
    expect(refused.err()).toBe('error: no project here\nfix: aw init --yes\n');
    expect(refused.out()).toBe('');
  });

  it('prints no fix line when there is none', () => {
    const refused = collectingIo();
    expect(reportFailure(refused.io, new CommandRefusedError('stopped'), false)).toBe(
      EXIT_CODE.problem,
    );
    expect(refused.err()).toBe('error: stopped\n');
  });

  it('is outranked by an interrupt, which still exits 130', () => {
    const interrupted = collectingIo();
    expect(reportFailure(interrupted.io, new CommandRefusedError('stopped', 'retry'), true)).toBe(
      EXIT_CODE.interrupted,
    );
    expect(interrupted.err()).toBe('interrupted\n');
  });
});

describe('reportFailure: --strict dropped fields (ADR-0133)', () => {
  it('exits 5 and leaves the existing codes unchanged', () => {
    const dropped = collectingIo();
    expect(
      reportFailure(dropped.io, new PlatformFieldsDroppedError('2 fields dropped'), false),
    ).toBe(5);
    expect(dropped.err()).toBe('error: 2 fields dropped\n');
    expect(EXIT_CODE).toEqual({
      ok: 0,
      problem: 1,
      usage: 2,
      contract: 3,
      transport: 4,
      dropped: 5,
      interrupted: 130,
    });
  });
});
