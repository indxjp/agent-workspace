/**
 * An agent's memory folder (ADR-0163): the workspace folder `memory/<agentId>/`, handed to a run
 * read-write at `memory/` under its working directory, and written back after a completed run.
 *
 * It is not a memory engine. Nothing here searches, ranks or injects a fact: the folder's files
 * ride the grant path like any assigned file (`loadMemoryFolder`, `./resource-loader.ts`), and the
 * engine reads them itself. A member sees and deletes them in the file browser, and a deleted file
 * is not handed to the next run.
 */
import { createHash } from 'node:crypto';

import {
  AGENT_MEMORY_DIRECTORY,
  AGENT_MEMORY_LIMIT_EXCEEDED,
  AGENT_MEMORY_MAX_BYTES,
  AGENT_MEMORY_MAX_FILES,
} from '@indx-workspace/contracts/agents';

import { DomainError } from '../errors';
import type { RunFileGrant } from './resource-loader';

/** The run-failure of a memory folder over either bound, naming both. */
export function memoryLimitExceeded(): DomainError {
  return new DomainError({
    category: 'validation',
    code: AGENT_MEMORY_LIMIT_EXCEEDED,
    publicMessage:
      `${AGENT_MEMORY_LIMIT_EXCEEDED}: the run left more than ${String(AGENT_MEMORY_MAX_FILES)} ` +
      `files or more than ${String(AGENT_MEMORY_MAX_BYTES)} bytes in memory/; nothing was saved ` +
      'to the memory folder. Keep fewer, shorter memory files.',
  });
}

/** Whether a run path is the memory directory or inside it. */
export function isUnderMemoryDirectory(path: string): boolean {
  return path === AGENT_MEMORY_DIRECTORY || path.startsWith(`${AGENT_MEMORY_DIRECTORY}/`);
}

/**
 * A run's files with its memory folder in place of anything else under `memory/`: the memory
 * folder owns that directory, so no other grant is handed there or written back from it. No
 * memory, the files unchanged.
 */
export function withMemoryFiles(
  files: readonly RunFileGrant[],
  memory: readonly RunFileGrant[] | undefined,
): RunFileGrant[] {
  if (memory === undefined) return [...files];
  return [...files.filter((file) => !isUnderMemoryDirectory(file.path)), ...memory];
}

/** One file a run left under `memory/`, as the write-back saves it. */
export interface MemoryWrite {
  /** The workspace path: `memory/<agentId>/<path>`. */
  readonly key: string;
  readonly data: Uint8Array;
}

/** What one run wrote back to its memory folder: the files and their bytes, for the audit row. */
export interface MemoryWriteCounts {
  readonly written: number;
  readonly unchanged: number;
  readonly bytes: number;
}

/**
 * The files to save, after the bounds: more than {@link AGENT_MEMORY_MAX_FILES} files or more than
 * {@link AGENT_MEMORY_MAX_BYTES} bytes in total refuses the whole folder with
 * `memory_limit_exceeded`, before anything is written.
 */
export function boundedMemoryWrites(writes: readonly MemoryWrite[]): readonly MemoryWrite[] {
  const bytes = writes.reduce((total, write) => total + write.data.byteLength, 0);
  if (writes.length > AGENT_MEMORY_MAX_FILES || bytes > AGENT_MEMORY_MAX_BYTES) {
    throw memoryLimitExceeded();
  }
  return writes;
}

/** The SHA-256 of a memory file's bytes, compared with the stored row's to skip an unchanged one. */
export function memorySha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The audit row's label: the run and counts, built here and from nothing else, so it never holds a
 * path, a file name the agent chose or a fact from the folder.
 */
export function memoryUpdatedLabel(runId: string, counts: MemoryWriteCounts): string {
  return [
    `run ${runId}`,
    `${String(counts.written)} written`,
    `${String(counts.unchanged)} unchanged`,
    `${String(counts.bytes)} bytes`,
  ].join(' · ');
}
