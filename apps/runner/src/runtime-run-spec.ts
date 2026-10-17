import { z } from 'zod';

import { RuntimeProfile } from '@agent-workspace/core';
import type { RuntimeRunSpec } from '@agent-workspace/runtime';

/** Validates the resolved runtime constraints accepted by the manager's HTTP boundary. */
const RuntimeRunSpecSchema = RuntimeProfile.omit({ id: true, name: true })
  .extend({ runtimeProfileId: z.string().min(1) })
  .strict();

type RuntimeRunSpecSchemaKey = keyof typeof RuntimeRunSpecSchema.shape;
type MissingRuntimeRunSpecKey = Exclude<keyof RuntimeRunSpec, RuntimeRunSpecSchemaKey>;
type ExtraRuntimeRunSpecKey = Exclude<RuntimeRunSpecSchemaKey, keyof RuntimeRunSpec>;
const runtimeRunSpecKeysAreComplete: [MissingRuntimeRunSpecKey, ExtraRuntimeRunSpecKey] extends [
  never,
  never,
]
  ? true
  : never = true;
void runtimeRunSpecKeysAreComplete;

export function parseRuntimeRunSpec(rawValue: unknown, expectedDriver: string): RuntimeRunSpec {
  const parsed = RuntimeRunSpecSchema.safeParse(rawValue);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'runSpec'}: ${issue.message}`)
      .join('; ');
    throw new Error(`runSpec is invalid: ${detail}`);
  }
  if (parsed.data.driver !== expectedDriver) {
    throw new Error(`runSpec must select a ${expectedDriver} runtime profile`);
  }
  const value = parsed.data;
  return {
    runtimeProfileId: value.runtimeProfileId,
    driver: value.driver,
    networkPolicy: value.networkPolicy,
    filesystem: value.filesystem,
    ...(value.runtimeConnectionId === undefined
      ? {}
      : { runtimeConnectionId: value.runtimeConnectionId }),
    ...(value.cpu === undefined ? {} : { cpu: value.cpu }),
    ...(value.memoryMb === undefined ? {} : { memoryMb: value.memoryMb }),
    ...(value.diskMb === undefined ? {} : { diskMb: value.diskMb }),
    ...(value.allowedDomains === undefined ? {} : { allowedDomains: value.allowedDomains }),
    ...(value.persistPaths === undefined ? {} : { persistPaths: value.persistPaths }),
    ...(value.timeoutSeconds === undefined ? {} : { timeoutSeconds: value.timeoutSeconds }),
    ...(value.idleTimeoutSeconds === undefined
      ? {}
      : { idleTimeoutSeconds: value.idleTimeoutSeconds }),
    ...(value.driverConfig === undefined ? {} : { driverConfig: value.driverConfig }),
  };
}
