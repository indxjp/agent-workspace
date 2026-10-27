import { SHARE_TRANSCRIPT_MAX_BYTES } from '@indx-workspace/contracts/shares';

import { DomainError } from '../../errors';
import { unstorableTextPath } from '../../sessions/transcript';

export interface SnapshotOptions {
  readonly technicalDetails?: boolean;
  readonly outputFiles?: boolean;
}
const SENSITIVE_KEY =
  /(secret|token|credential|password|authorization|api[_-]?key|environment|env)/i;
const INTERNAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|[^\s"']+\.(?:internal|local)|gateway(?::\d+)?)(?:\/[^\s"']*)?/gi;
export function createSessionSnapshot(
  entries: readonly unknown[],
  secretValues: readonly string[],
  options: SnapshotOptions = {},
): readonly unknown[] {
  const redact = (value: unknown, key = ''): unknown => {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (typeof value === 'string') {
      let result = value.replace(INTERNAL_URL, '[REDACTED_URL]');
      for (const secret of secretValues.filter(Boolean))
        result = result.split(secret).join('[REDACTED]');
      return result;
    }
    if (Array.isArray(value)) return value.map((item) => redact(item, key));
    if (value && typeof value === 'object') {
      const input = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(input)) {
        if (
          !options.technicalDetails &&
          ['rawSdkEvent', 'raw_event', 'tokenUsage'].includes(childKey)
        )
          continue;
        if (
          !options.outputFiles &&
          ['fileContent', 'contentBytes', 'attachments'].includes(childKey)
        )
          continue;
        if (!options.technicalDetails && ['toolArguments', 'arguments', 'input'].includes(childKey))
          continue;
        output[childKey] = redact(child, childKey);
      }
      return output;
    }
    return value;
  };
  return entries.map((entry) => redact(entry));
}

/** One stored run of the shared session, as the share reads it: its prompt and final answer. */
export interface SharedRun {
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: Date;
  readonly prompt: string | null;
  /** The completed run's final answer text; `null` for a run that did not complete. */
  readonly answer: string | null;
}

/** What a session share with a transcript stores and the public page renders (ADR-0158). */
export interface SessionTranscriptSnapshot {
  readonly kind: 'session-transcript';
  readonly version: 1;
  readonly turns: readonly { readonly prompt: string | null; readonly answer: string | null }[];
}

function invalidTranscript(publicMessage: string): DomainError {
  return new DomainError({ category: 'validation', code: 'invalid_share', publicMessage });
}

/**
 * The transcript a session share publishes, copied from the session's own runs (ADR-0158). `runs`
 * answers `transcript.runIds` index for index, `null` where the workspace holds no such run; an
 * unknown run and a run of another session are refused alike, so the answer reveals nothing else.
 */
export function sessionTranscriptSnapshot(
  sessionId: string,
  runs: readonly (SharedRun | null)[],
  secretValues: readonly string[],
): SessionTranscriptSnapshot {
  const checked = runs.map((run, index) => {
    if (run === null || run.sessionId !== sessionId)
      throw invalidTranscript(`transcript.runIds[${String(index)}] is not a run of this session.`);
    return run;
  });
  const ordered = checked.toSorted(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  // Masking replaces text inside strings and keeps every key, so the turns keep their shape.
  const turns = createSessionSnapshot(
    ordered.map(({ prompt, answer }) => ({ prompt, answer })),
    secretValues,
  ) as SessionTranscriptSnapshot['turns'];
  const snapshot: SessionTranscriptSnapshot = { kind: 'session-transcript', version: 1, turns };
  if (unstorableTextPath(snapshot, 'transcript') !== null)
    throw invalidTranscript('The transcript holds text that cannot be stored.');
  if (Buffer.byteLength(JSON.stringify(snapshot)) > SHARE_TRANSCRIPT_MAX_BYTES)
    throw invalidTranscript(
      `The transcript is larger than ${String(SHARE_TRANSCRIPT_MAX_BYTES)} bytes; choose fewer turns.`,
    );
  return snapshot;
}
