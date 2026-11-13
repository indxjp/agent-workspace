/**
 * The publish route's two steps around the rules: reading the request (a refusal becomes the
 * `invalid_share` error) and building the content a share publishes, which reads the session's
 * runs and masks secrets through other domains.
 */
import { DomainError } from '../errors';
import { exportAgentDefinition } from './agent-definition/definition';
import { readPublishShareRequest, type PublishShareRequest } from './core/input';
import { sessionTranscriptSnapshot, type SharedRun } from './session-snapshot/snapshot';

export function parsePublishShareRequest(value: unknown): PublishShareRequest {
  const read = readPublishShareRequest(value);
  if (read.ok) return read.request;
  throw new DomainError({
    category: 'validation',
    code: 'invalid_share',
    publicMessage: read.detail,
  });
}

/**
 * The content a share publishes, always through the server's secret masking: a session's
 * transcript, copied from the runs the caller chose (ADR-0158), or an agent's definition. A
 * caller-authored raw `snapshot` is never stored — it would skip the masking. The definition is
 * still caller-authored until RF-103 builds it from the stored subject.
 */
export async function publishedSnapshot(
  body: PublishShareRequest,
  materials: { readonly values: readonly string[]; readonly referenceIds: readonly string[] },
  sessionRuns: (runIds: readonly string[]) => Promise<readonly (SharedRun | null)[]>,
): Promise<unknown> {
  if (body.subjectType === 'session' && body.transcript !== undefined) {
    return sessionTranscriptSnapshot(
      body.subjectId,
      await sessionRuns(body.transcript.runIds),
      materials.values,
    );
  }
  if (body.subjectType === 'agent' && body.definition) {
    return exportAgentDefinition(body.definition, materials.values, materials.referenceIds);
  }
  return undefined;
}
