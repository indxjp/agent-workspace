import type { ServerResponse } from 'node:http';
import type { Logger } from '@agent-workspace/core/telemetry';
import { RunRequest, type RunFileReference } from '@agent-workspace/run-protocol';
import { loadEngine } from './engines.js';
import { sendError } from './http-io.js';
import {
  readSkillInbox,
  removeSkillInbox,
  SkillInboxMismatchError,
  withoutSkills,
  type ResolvedRunRequest,
} from './resources.js';
import { verifyReferencedFiles } from './verify-files.js';
import { streamEngineRefusal } from './run-stream.js';

export async function resolveRunResources(
  res: ServerResponse,
  parsed: RunRequest,
  log: Logger,
  references: readonly RunFileReference[],
): Promise<ResolvedRunRequest | undefined> {
  // Inside the admission window, so hashing a large grant counts against `maxConcurrentRuns`.
  let request: ResolvedRunRequest | undefined;
  const skillReferences = parsed.resources?.skills ?? [];
  if (references.length === 0) return withoutSkills(parsed);
  // The engine's protected configuration directory is the writer's guard too; without the
  // engine there is no guard to apply, and the run would be refused at start anyway.
  const lookup = await loadEngine(parsed.engine);
  if (!lookup.ok) {
    await streamEngineRefusal(res, parsed.runId, lookup.code, lookup.reason);
    return;
  }
  const guard = lookup.engine.protectedConfigDirectory;
  let inboxLeft = false;
  try {
    const verification = await verifyReferencedFiles(parsed.cwd, guard, references);
    if (!verification.ok) {
      sendError(
        res,
        422,
        verification.code,
        `granted file "${verification.path}" did not arrive intact`,
      );
      return;
    }
    try {
      request = await readSkillInbox(parsed, guard);
    } catch (error) {
      // The message can name an absolute host path; it is logged, never answered.
      log.error('skill inbox read failed after verification', { error: String(error) });
      sendError(
        res,
        422,
        error instanceof SkillInboxMismatchError
          ? 'run_file_checksum_mismatch'
          : 'run_file_missing',
        'a granted skill file did not arrive intact',
      );
      return;
    }
  } finally {
    if (skillReferences.length > 0) {
      try {
        removeSkillInbox(parsed.cwd, guard);
      } catch (error) {
        // The message can name an absolute host path; it is logged, never answered.
        log.error('skill inbox removal failed', { error: String(error) });
        inboxLeft = true;
      }
    }
  }
  // Reached only when nothing was answered above: an agent must never see a leftover inbox.
  if (inboxLeft) {
    sendError(res, 500, 'internal_error', 'the granted skill files could not be cleared');
    return;
  }
  // Every skill reference names a file, so a request that grants skills has read the inbox above.
  return request ?? withoutSkills(parsed);
}
