import { describe, expect, it } from 'vitest';
import { SHARE_TRANSCRIPT_MAX_BYTES } from '@indx-workspace/contracts/shares';

import { createSessionSnapshot, sessionTranscriptSnapshot } from './snapshot';

describe('createSessionSnapshot', () => {
  it('redacts secret values, secret-shaped fields and internal URLs at creation', () => {
    const snapshot = createSessionSnapshot(
      [
        {
          message: 'token=swordfish at http://gateway:8787/v1',
          environment: { SAFE: 'swordfish' },
        },
      ],
      ['swordfish'],
    );
    expect(JSON.stringify(snapshot)).not.toContain('swordfish');
    expect(JSON.stringify(snapshot)).not.toContain('gateway:8787');
  });

  it('excludes technical details and file contents unless opted in', () => {
    const entry = { message: 'ok', rawSdkEvent: { type: 'raw' }, fileContent: 'customer data' };
    expect(createSessionSnapshot([entry], [])).toEqual([{ message: 'ok' }]);
    expect(
      createSessionSnapshot([entry], [], { technicalDetails: true, outputFiles: true }),
    ).toEqual([entry]);
  });
});

describe('sessionTranscriptSnapshot (ADR-0158)', () => {
  const session = '55555555-5555-4555-8555-555555555555';
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const run = (id: string, at: string, prompt: string | null, answer: string | null) => ({
    id,
    sessionId: session,
    createdAt: new Date(at),
    prompt,
    answer,
  });
  const stored = [
    run(second, '2026-10-19T10:01:00Z', 'And now?', null),
    run(first, '2026-10-19T10:00:00Z', 'My key is swordfish', 'Noted, see http://gateway:8787/x'),
  ];

  it('copies the stored turns in run order, text only, with secrets masked', () => {
    const snapshot = sessionTranscriptSnapshot(session, stored, ['swordfish']);
    expect(snapshot).toEqual({
      kind: 'session-transcript',
      version: 1,
      turns: [
        { prompt: 'My key is [REDACTED]', answer: 'Noted, see [REDACTED_URL]' },
        { prompt: 'And now?', answer: null },
      ],
    });
  });

  it('refuses an unknown run and a run of another session with the same sentence', () => {
    const foreign = { ...stored[1]!, sessionId: '66666666-6666-4666-8666-666666666666' };
    for (const runs of [
      [stored[0]!, null],
      [stored[0]!, foreign],
    ]) {
      expect(() => sessionTranscriptSnapshot(session, runs, [])).toThrow(
        expect.objectContaining({
          code: 'invalid_share',
          publicMessage: 'transcript.runIds[1] is not a run of this session.',
        }),
      );
    }
  });

  it('refuses a transcript larger than the published bound', () => {
    const large = run(first, '2026-10-19T10:00:00Z', 'x'.repeat(SHARE_TRANSCRIPT_MAX_BYTES), null);
    expect(() => sessionTranscriptSnapshot(session, [large], [])).toThrow(
      expect.objectContaining({ code: 'invalid_share' }),
    );
  });

  it('refuses text the store could not hold', () => {
    const nul = run(first, '2026-10-19T10:00:00Z', 'a\u0000b', null);
    expect(() => sessionTranscriptSnapshot(session, [nul], [])).toThrow(
      expect.objectContaining({ code: 'invalid_share' }),
    );
  });
});
