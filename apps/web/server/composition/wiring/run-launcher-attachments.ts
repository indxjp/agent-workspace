import { readBytes } from '@agent-workspace/core/storage/streams';
import { MAX_UPLOAD_BYTES } from '@indx-workspace/contracts/files';
import type { ModelProvider } from '@indx-workspace/contracts/runs';

import { runStartRefusalError } from '../../compose/run-preflight';
import type { FilesRuntime } from '../../files/runtime';
import type { ResolvedModelConnection } from '../../models/store';
import type { LaunchContext } from '../../runs/environment';
import { atStep } from '../../runs/failures';
import {
  isAudioAttachment,
  promptWithTranscription,
  transcribes,
  untranscribableRefusal,
} from '../../runs/transcription';

/**
 * Transcribe recordings through the run's current model connection. Recheck the provider at
 * launch because its connection may have changed since the run was accepted.
 */
export async function withTranscription(input: {
  readonly context: LaunchContext;
  readonly provider: ModelProvider;
  readonly resolveConnection: () => Promise<ResolvedModelConnection | null>;
  readonly readBytes: (path: string) => Promise<Uint8Array | null>;
  readonly request?: typeof fetch;
  /** Whether the run is still `queued`; an interrupt makes it terminal and stops transcription. */
  readonly stillQueued?: () => Promise<boolean>;
}): Promise<LaunchContext> {
  const attachments = input.context.attachments ?? [];
  if (!attachments.some(isAudioAttachment)) return input.context;
  if (!transcribes(input.provider)) {
    throw runStartRefusalError(untranscribableRefusal(input.provider));
  }
  const prompt = await atStep('transcription', async () => {
    const connection = await input.resolveConnection();
    if (connection === null) throw new Error('the run model connection could not be read');
    return promptWithTranscription({
      prompt: input.context.prompt,
      attachments,
      connection,
      readBytes: input.readBytes,
      ...(input.request === undefined ? {} : { request: input.request }),
      ...(input.stillQueued === undefined ? {} : { stillQueued: input.stillQueued }),
    });
  });
  return { ...input.context, prompt };
}

/**
 * The bytes of the ready file at `path` through the catalog service, capped at `MAX_UPLOAD_BYTES`,
 * for transcription; `null` without a catalog service or a ready file there.
 */
export async function readAttachmentBytes(
  filesRuntime: Pick<FilesRuntime, 'catalog' | 'storage'> | null | undefined,
  workspaceId: string,
  path: string,
): Promise<Uint8Array | null> {
  const storage = filesRuntime?.storage;
  if (storage === undefined || filesRuntime?.catalog === undefined) return null;
  const row = await (await filesRuntime.catalog.forWorkspace(workspaceId)).get(path);
  const opened =
    row === null || row.kind !== 'file' ? null : await storage.open({ workspaceId }, row);
  return opened === null ? null : readBytes(opened.body, MAX_UPLOAD_BYTES);
}
