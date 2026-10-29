import type { ModelConnectionRecord } from '@agent-workspace/core/db';
import { createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';
import { readWhole } from '@agent-workspace/core/storage/streams';
import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';
import { describe, expect, it, vi } from 'vitest';

import { InfrastructureError } from '../errors';
import type { ResolvedModelConnection } from '../models/store';
import { atStep, publicPreparationFailure } from './failures';
import {
  TRANSCRIPTION_MODEL,
  TRANSCRIPT_MAX_BYTES,
  isAudioAttachment,
  promptWithTranscription,
  promptWithTranscripts,
  transcribeAudio,
  transcribes,
  untranscribableRefusal,
} from './transcription';

const BASE = 'http://127.0.0.1:9/v1';
const KEY = 'sk-transcription-secret';

function openai(baseUrl: string = BASE): ResolvedModelConnection {
  const connection: ModelConnectionRecord = {
    id: 'conn-1',
    workspaceId: 'ws-1',
    name: 'OpenAI',
    provider: 'openai',
    config: { baseUrl },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  return { connection, credential: KEY };
}

const file = (path: string, kind: 'file' | 'directory' = 'file') => ({
  fileId: 'f',
  path,
  kind,
});

describe('isAudioAttachment', () => {
  it.each([
    ['meetings/a.m4a', true],
    ['meetings/A.MP3', true],
    ['a.webm', true],
    ['a.wav', true],
    ['meetings/a.vtt', false],
    ['notes/brief.txt', false],
    ['notes/m4a', false],
    ['.m4a', false],
  ])('%s -> %s', (path, expected) => {
    expect(isAudioAttachment(file(path))).toBe(expected);
  });

  it('never treats a folder as audio', () => {
    expect(isAudioAttachment(file('recordings.m4a', 'directory'))).toBe(false);
  });
});

describe('transcribes', () => {
  it('is true for openai and for no other provider', () => {
    expect(MODEL_PROVIDERS.filter(transcribes)).toEqual(['openai']);
  });

  it('names the provider in the refusal', () => {
    expect(untranscribableRefusal('anthropic').message).toContain('anthropic provider');
    expect(untranscribableRefusal('anthropic').code).toBe('run_attachments_untranscribable');
  });
});

describe('transcribeAudio', () => {
  it('posts a multipart file with the model and a bearer key to the connection', async () => {
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response(' hello team \n')));
    const text = await transcribeAudio(
      openai(`${BASE}/`),
      { path: 'meetings/a.m4a', body: new Uint8Array([1, 2, 3]) },
      request,
    );
    expect(text).toBe('hello team');
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/audio/transcriptions`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ authorization: `Bearer ${KEY}` });
    const form = init?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error('not a form');
    expect(form.get('model')).toBe(TRANSCRIPTION_MODEL);
    expect(form.get('response_format')).toBe('text');
    const part = form.get('file');
    expect(part).toBeInstanceOf(File);
    if (!(part instanceof File)) throw new Error('not a file');
    expect(part.name).toBe('a.m4a');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('turns a provider failure into an InfrastructureError that carries no provider text', async () => {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(`invalid key ${KEY}`, { status: 500 })),
    );
    const failure = await transcribeAudio(
      openai(),
      { path: 'a.m4a', body: new Uint8Array([1]) },
      request,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).failureKind).toBe('upstream');
    expect((failure as InfrastructureError).message).not.toContain(KEY);
    expect(String((failure as InfrastructureError).cause)).not.toContain(KEY);
  });

  it('refuses a provider body past the transcript cap without buffering it', async () => {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('x'.repeat(TRANSCRIPT_MAX_BYTES + 1))),
    );
    const failure = await transcribeAudio(
      openai(),
      { path: 'a.m4a', body: new Uint8Array([1]) },
      request,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect(String((failure as InfrastructureError).cause)).toContain('exceeded');
  });

  it('turns a network failure into an InfrastructureError', async () => {
    const request = vi.fn<typeof fetch>(() => Promise.reject(new Error('socket hang up')));
    await expect(
      transcribeAudio(openai(), { path: 'a.m4a', body: new Uint8Array([1]) }, request),
    ).rejects.toBeInstanceOf(InfrastructureError);
  });
});

describe('promptWithTranscripts', () => {
  it('leaves a prompt without recordings alone', () => {
    expect(promptWithTranscripts('hi', [])).toBe('hi');
  });

  it('appends one block per recording, in order', () => {
    expect(
      promptWithTranscripts('minutes please', [
        { path: 'a.m4a', text: 'first' },
        { path: 'b.wav', text: 'second' },
      ]),
    ).toBe('minutes please\n\nTranscript of a.m4a:\nfirst\n\nTranscript of b.wav:\nsecond');
  });
});

describe('promptWithTranscription (the transcript reaches the turn, issue #1313)', () => {
  const store = async () => {
    const objects = createInMemoryObjectStoreProvider().forWorkspace('ws-1');
    await objects.write('meetings/a.m4a', new Uint8Array([7, 7]), {});
    await objects.write('meetings/agenda.md', new TextEncoder().encode('agenda'), {});
    return objects;
  };
  const attachments = [file('meetings/agenda.md'), file('meetings/a.m4a')];

  it('transcribes only the audio files and keeps the attachment lines', async () => {
    const objects = await store();
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response('we agreed on May')));
    const prompt = await promptWithTranscription({
      prompt: 'minutes\n\nAttached (read-only): meetings/a.m4a',
      attachments,
      connection: openai(),
      readBytes: async (path) => (await readWhole(objects, path))?.body ?? null,
      request,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(prompt).toContain('Attached (read-only): meetings/a.m4a');
    expect(prompt).toContain('Transcript of meetings/a.m4a:\nwe agreed on May');
    expect(prompt).not.toContain('agenda\n');
  });

  it('stops before the next recording once an interrupt has ended the run', async () => {
    const objects = await store();
    await objects.write('meetings/b.wav', new Uint8Array([8]), {});
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response('text')));
    const stillQueued = vi.fn<() => Promise<boolean>>();
    stillQueued.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      promptWithTranscription({
        prompt: 'x',
        attachments: [file('meetings/a.m4a'), file('meetings/b.wav')],
        connection: openai(),
        readBytes: async (path) => (await readWhole(objects, path))?.body ?? null,
        request,
        stillQueued,
      }),
    ).rejects.toThrow('interrupted');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fails the preparation when the audio file is gone', async () => {
    await expect(
      promptWithTranscription({
        prompt: 'x',
        attachments,
        connection: openai(),
        readBytes: () => Promise.resolve(null),
        request: vi.fn<typeof fetch>(),
      }),
    ).rejects.toThrow('could not be read');
  });

  it('a provider 500 fails the run at the transcription step with the generic message', async () => {
    const objects = await store();
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(`boom ${KEY}`, { status: 500 })),
    );
    const failure = await atStep('transcription', () =>
      promptWithTranscription({
        prompt: 'x',
        attachments,
        connection: openai(),
        readBytes: async (path) => (await readWhole(objects, path))?.body ?? null,
        request,
      }),
    ).catch((error: unknown) => error);
    const log = vi.fn();
    const message = publicPreparationFailure(failure, [KEY], log);
    expect(message).toContain('at the transcription step');
    expect(message).not.toContain(KEY);
    expect(String(log.mock.calls[0]?.[0])).not.toContain(KEY);
  });
});
