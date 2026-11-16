import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';

import {
  eventStreamResponse as stream,
  jsonResponse as json,
  type RecordedRequest,
} from '../testing.js';

import { RUN, run, detail, client } from './runs.fixture.test-support.js';

describe('RunsClient.result (ADR-0143)', () => {
  const answer = { text: '{"verdict":"ok"}', structured: { verdict: 'ok' } };
  const settledWith = (status: string, output: unknown) =>
    client((call) =>
      call.url.pathname.endsWith('/events')
        ? stream('event: done\n\n')
        : json(200, { run: detail(run(status, output)) }),
    ).runs;

  it('returns the text and the structured output of a completed run', async () => {
    const result = await settledWith('completed', answer).result(RUN);
    expect(result.text).toBe(answer.text);
    expect(result.output).toEqual({ verdict: 'ok' });
    expect(result.run.status).toBe('completed');
  });

  it('parses the output with the schema and types it', async () => {
    const schema = z.object({ verdict: z.string() });
    const result = await settledWith('completed', answer).result(RUN, { schema });
    expectTypeOf(result.output).toEqualTypeOf<{ verdict: string } | null>();
    expect(result.output?.verdict).toBe('ok');
  });

  it('raises ContractViolationError when the output does not match the schema', async () => {
    const schema = z.object({ verdict: z.number() });
    const failure = await settledWith('completed', answer)
      .result(RUN, { schema })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).message).toContain('runs.result');
    expect((failure as ContractViolationError).issues[0]).toContain('verdict');
  });

  it('returns a null structured output as null, with the text, when the run asked for none', async () => {
    const plain = { text: 'hello', structured: null };
    const result = await settledWith('completed', plain).result(RUN, {
      schema: z.object({ verdict: z.string() }),
    });
    expect(result).toMatchObject({ text: 'hello', output: null });
  });

  it('resolves a failed or cancelled run with no text and no output', async () => {
    for (const status of ['failed', 'cancelled']) {
      const result = await settledWith(status, null).result(RUN);
      expect(result).toMatchObject({ text: null, output: null });
      expect(result.run.status).toBe(status);
    }
  });
});

describe('RunsClient.outputs', () => {
  const file = (
    path: string,
    kind: 'file' | 'folder' = 'file',
    contentType: string | null = null,
  ) => ({
    id: `id:${path}`,
    path,
    kind,
    sizeBytes: kind === 'file' ? 4 : null,
    contentType,
    lastModified: kind === 'file' ? '2026-10-17T10:00:00.000Z' : null,
  });
  const root = `runs/${RUN}/outputs`;
  const tree: Record<string, readonly unknown[]> = {
    [root]: [
      file(`${root}/BRK-1101.dxf`),
      file(`${root}/report.pdf`, 'file', 'application/pdf'),
      file(`${root}/reports`, 'folder'),
    ],
    [`${root}/reports`]: [file(`${root}/reports/summary.md`)],
  };
  const served = (request: RecordedRequest): Response =>
    json(200, { files: tree[request.url.searchParams.get('path') ?? ''] ?? [] });

  // @story US-STO-07
  it('[US-STO-07][api][sdk] outputs appear with the right type', async () => {
    const { runs } = client(served);
    const files = await runs.outputs(RUN);
    expect(files.find((f) => f.name === 'report.pdf')?.contentType).toBe('application/pdf');
  });

  it('lists the run prefix only, walks folders and names files relative to outputs/', async () => {
    const { runs, calls } = client(served);
    const files = await runs.outputs(RUN);
    expect(files.map((f) => [f.name, f.path])).toEqual([
      ['BRK-1101.dxf', `${root}/BRK-1101.dxf`],
      ['report.pdf', `${root}/report.pdf`],
      ['reports/summary.md', `${root}/reports/summary.md`],
    ]);
    expect(calls.map((c) => [c.method, c.url.pathname, c.url.searchParams.get('path')])).toEqual([
      ['GET', '/api/files', root],
      ['GET', '/api/files', `${root}/reports`],
    ]);
  });

  it('answers an empty list for a run that wrote nothing', async () => {
    const { runs } = client(() => json(200, { files: [] }));
    expect(await runs.outputs(RUN)).toEqual([]);
  });

  it('passes the signal on every request, so aborting mid-walk stops it', async () => {
    const controller = new AbortController();
    const { runs, calls } = client((request) => {
      if (request.init.signal?.aborted === true)
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      // The caller aborts once the first level has been listed.
      controller.abort();
      return served(request);
    });
    const failure = await runs.outputs(RUN, { signal: controller.signal }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls.map((c) => c.url.searchParams.get('path'))).toEqual([root, `${root}/reports`]);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runs } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const failure = await runs.outputs(RUN, { signal: controller.signal }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });

  it('surfaces a problem as an ApiProblemError and drift as a contract violation', async () => {
    const problem = client(() =>
      json(400, { error: { code: 'invalid_path', message: 'not a valid path' } }),
    );
    expect(await problem.runs.outputs(RUN).catch((e: unknown) => e)).toBeInstanceOf(
      ApiProblemError,
    );
    const drift = client(() => json(200, { entries: [] }));
    expect(await drift.runs.outputs(RUN).catch((e: unknown) => e)).toBeInstanceOf(
      ContractViolationError,
    );
  });
});
