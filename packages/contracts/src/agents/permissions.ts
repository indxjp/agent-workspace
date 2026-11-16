import { z } from 'zod';

/**
 * The four permission switches carried by every agent request and response, in the specification's
 * order. `apps/web/server/agents/contract.test.ts` keeps this list aligned with the database schema.
 * `memory` (ADR-0163) sits beside them in {@link AgentPermissionsSchema} but is not a switch: it is
 * never withheld by an engine arm or capped by name, and it is in force only while both file
 * switches are on ({@link agentMemoryEnabled}).
 */
export const AGENT_PERMISSION_KEYS = [
  'readFiles',
  'writeFiles',
  'runCommands',
  'unrestrictedNetwork',
] as const;

/**
 * The scopes an agent's memory folder may have (ADR-0163). Only `agent` ships: one folder per
 * agent. A per-person scope waits for per-person file grants (#1281) and is refused until then.
 */
export const AGENT_MEMORY_SCOPES = ['agent'] as const;

export const AgentMemoryScopeSchema = z.enum(AGENT_MEMORY_SCOPES);

export type AgentMemoryScope = z.infer<typeof AgentMemoryScopeSchema>;

export const AgentPermissionsSchema = z
  .object({
    readFiles: z.boolean(),
    writeFiles: z.boolean(),
    /** ADR-0163: keep a memory folder across sessions. Absent means off. */
    memory: AgentMemoryScopeSchema.optional(),
    runCommands: z.boolean(),
    unrestrictedNetwork: z.boolean(),
  })
  .strict()
  .readonly();

export type AgentPermissionKey = (typeof AGENT_PERMISSION_KEYS)[number];
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;

/** The directory under a run's working directory where its memory folder is materialised. */
export const AGENT_MEMORY_DIRECTORY = 'memory';

/** The file the engine is told to keep its durable facts in, relative to the working directory. */
export const AGENT_MEMORY_FILE = `${AGENT_MEMORY_DIRECTORY}/MEMORY.md`;

/** At most this many files are written back to a memory folder by one run. */
export const AGENT_MEMORY_MAX_FILES = 64;

/** At most this many bytes, in total, are written back to a memory folder by one run. */
export const AGENT_MEMORY_MAX_BYTES = 256 * 1024;

/** The run-failure code of a run whose memory folder is over either bound. */
export const AGENT_MEMORY_LIMIT_EXCEEDED = 'memory_limit_exceeded';

/**
 * Whether a run with these composed permissions keeps a memory folder: `memory` is set and the run
 * may both read and write files. A run whose file switches were narrowed (a public share, a
 * withholding arm, the deployment ceiling) has no memory, so memory never widens a run.
 */
export function agentMemoryEnabled(permissions: AgentPermissions): boolean {
  return permissions.memory === 'agent' && permissions.readFiles && permissions.writeFiles;
}

/**
 * The workspace file-store folder an agent's memory lives in: `memory/<agentId>`. Keyed by id, not
 * name, so a renamed agent keeps its memory and a new agent given an old name does not inherit it.
 */
export function agentMemoryFolder(agentId: string): string {
  return `${AGENT_MEMORY_DIRECTORY}/${agentId}`;
}
