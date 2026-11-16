/** Opaque, restart-stable Azure session identifiers derived from a manager secret. */
import { createHmac } from 'node:crypto';

import type { RuntimeConfig } from './driver.js';
import { requireValue } from './aca-sessions-rest-client.js';

function identifierSecretBytes(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Uint8Array.from(value);
  if (bytes.byteLength < 32) {
    throw new Error('aca-sessions runtime: identifierSecret must contain at least 32 bytes.');
  }
  return bytes;
}

/**
 * Derive an opaque, allowed Azure identifier without exposing tenant, session, path, or profile
 * names. Length-prefixed JSON prevents ambiguous concatenations; hex stays inside Azure's allowed
 * identifier alphabet.
 */
export function createAcaSessionIdentifier(
  secret: string | Uint8Array,
  config: RuntimeConfig,
): string {
  const context = JSON.stringify([
    1,
    requireValue(config.sessionId, 'sessionId'),
    requireValue(config.workspacePath, 'workspacePath'),
    config.runtimeProfileId ?? config.runSpec?.runtimeProfileId ?? null,
  ]);
  return `aw-${createHmac('sha256', identifierSecretBytes(secret)).update(context).digest('hex')}`;
}
