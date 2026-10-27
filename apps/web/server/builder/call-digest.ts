import { createHash } from 'node:crypto';

import { canonicalCall } from '@indx-workspace/contracts/agents';

import type { BuilderToolName } from '@indx-workspace/contracts/builder';

/** The SHA-256 (hex) of the canonical text of one tool call: a stable name for "this tool with these arguments". */
export function callDigest(tool: BuilderToolName, args: unknown): string {
  return createHash('sha256').update(canonicalCall(tool, args)).digest('hex');
}
