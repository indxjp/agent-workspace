/**
 * Audio run attachments (issue #1313): an attached recording is transcribed through the run's own
 * model connection and the transcript joins the run's first turn. Only an `openai` connection
 * transcribes; every other provider is refused by name (`run_attachments_untranscribable`), because
 * Anthropic has no transcription API, Azure needs a per-connection deployment this platform does not
 * store, and an `openai-compatible` server may not have the route. No speech model is bundled.
 */
import { guardedFetch, loadEgressPolicyFromEnv } from '@agent-workspace/core';
import type { ModelProvider } from '@indx-workspace/contracts/runs';

import { readCappedBody } from '../endpoints/request';
import { InfrastructureError } from '../errors';
import type { ResolvedModelConnection } from '../models/store';
import type { ResolvedAttachment } from './attachments';

/** The model an `openai` connection transcribes with; fixed, not configurable. */
export const TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';

/** One transcription may take this long; it is bounded by the 10 MiB per-file attachment limit. */
const TRANSCRIPTION_TIMEOUT_MS = 300_000;

/**
 * The most transcript bytes read from the provider. A 10 MiB recording transcribes to tens of
 * kilobytes; a body past this is not a transcript, and it would otherwise be buffered whole.
 */
export const TRANSCRIPT_MAX_BYTES = 1024 * 1024;

/** The formats OpenAI's transcription endpoint accepts. */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'flac',
  'mp3',
  'mp4',
  'mpeg',
  'mpga',
  'm4a',
  'ogg',
  'wav',
  'webm',
]);

/** A file attachment whose extension is an audio format. A folder is never transcribed. */
export function isAudioAttachment(attachment: Pick<ResolvedAttachment, 'path' | 'kind'>): boolean {
  if (attachment.kind !== 'file') return false;
  const name = attachment.path.slice(attachment.path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && AUDIO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Whether a model connection of `provider` can transcribe. */
export function transcribes(provider: ModelProvider): boolean {
  return provider === 'openai';
}

/** The start refusal for an audio attachment on a provider that cannot transcribe it. */
export function untranscribableRefusal(provider: ModelProvider): {
  readonly code: 'run_attachments_untranscribable';
  readonly message: string;
} {
  return {
    code: 'run_attachments_untranscribable',
    message:
      `this run attaches an audio file, but its model connection uses the ${provider} provider, ` +
      'which cannot transcribe it; run it on an OpenAI connection, or attach a text transcript ' +
      'instead.',
  };
}

/** The transcript of one audio file, from the connection's `/audio/transcriptions` route. */
export async function transcribeAudio(
  resolved: ResolvedModelConnection,
  file: { readonly path: string; readonly body: Uint8Array },
  request: typeof fetch = fetch,
): Promise<string> {
  const base = resolved.connection.config.baseUrl?.replace(/\/$/u, '');
  const form = new FormData();
  form.set('model', TRANSCRIPTION_MODEL);
  form.set('response_format', 'text');
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  form.set('file', new Blob([new Uint8Array(file.body)]), name);
  try {
    const response = await guardedFetch(
      `${base ?? 'https://api.openai.com/v1'}/audio/transcriptions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${resolved.credential}` },
        body: form,
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      },
      loadEgressPolicyFromEnv(),
      request,
    );
    // The provider's body is never read into an error: only the status reaches diagnostics.
    if (!response.ok) throw new Error(`the provider answered HTTP ${String(response.status)}`);
    const body = await readCappedBody(response, TRANSCRIPT_MAX_BYTES);
    if (body.kind === 'too_large') {
      throw new Error(`the transcript exceeded ${String(TRANSCRIPT_MAX_BYTES)} bytes`);
    }
    if (body.kind === 'unreadable') throw new Error('the transcript could not be read');
    return body.text.trim();
  } catch (cause) {
    throw new InfrastructureError({
      component: 'runs',
      operation: 'transcribe-attachment',
      failureKind: 'upstream',
      cause,
    });
  }
}

/** The turn the run receives: the prompt followed by one transcript block per recording. */
export function promptWithTranscripts(
  prompt: string,
  transcripts: readonly { readonly path: string; readonly text: string }[],
): string {
  if (transcripts.length === 0) return prompt;
  return [prompt, ...transcripts.map(({ path, text }) => `\nTranscript of ${path}:\n${text}`)].join(
    '\n',
  );
}

/**
 * `prompt` with a transcript of every audio file among `attachments`, in order. `readBytes` reads a
 * stored file; a file that cannot be read fails the preparation rather than being skipped.
 * `stillQueued`, asked before each file, stops the work once an interrupt has ended the run: the
 * launcher then finds the run terminal and abandons the launch as interrupted.
 */
export async function promptWithTranscription(input: {
  readonly prompt: string;
  readonly attachments: readonly ResolvedAttachment[];
  readonly connection: ResolvedModelConnection;
  readonly readBytes: (path: string) => Promise<Uint8Array | null>;
  readonly request?: typeof fetch;
  readonly stillQueued?: () => Promise<boolean>;
}): Promise<string> {
  const transcripts: { path: string; text: string }[] = [];
  for (const { path } of input.attachments.filter(isAudioAttachment)) {
    // Asked between files: a recording already posted still runs to its timeout.
    if (input.stillQueued !== undefined && !(await input.stillQueued())) {
      throw new Error('the run was interrupted during transcription');
    }
    const body = await input.readBytes(path);
    if (body === null) throw new Error('an attached audio file could not be read');
    transcripts.push({
      path,
      text: await transcribeAudio(input.connection, { path, body }, input.request),
    });
  }
  return promptWithTranscripts(input.prompt, transcripts);
}
