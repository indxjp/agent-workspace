import type { RuntimeHandle } from '../driver.js';
import type { ExternalDriverId } from './model.js';
import type { SealedSandbox, Sealer } from './stateless.js';
type LiveSandbox = Readonly<{
  handle: RuntimeHandle;
  sandboxId: string;
  origin: string;
  bearer: string;
  accessHeaders: Readonly<Record<string, string>>;
  expiresAt: number;
}>;

export function createExternalState(driverId: ExternalDriverId, sealer: Sealer | undefined) {
  const live = new Map<string, LiveSandbox>();
  function handleOf(id: string, sealed: SealedSandbox): RuntimeHandle {
    return {
      id,
      driver: driverId,
      externalId: sealed.sandboxId,
      workspacePath: sealed.workspacePath,
      createdAt: new Date(sealed.createdAt),
      expiresAt: new Date(sealed.expiresAt),
    };
  }

  /** What this driver holds for a handle: its live table, else (stateless) what the id seals. */
  function lookup(id: string): LiveSandbox | undefined {
    const stored = live.get(id);
    if (stored !== undefined || sealer === undefined) return stored;
    const sealed = sealer.open(id);
    if (sealed === undefined) return undefined;
    return {
      handle: handleOf(id, sealed),
      sandboxId: sealed.sandboxId,
      origin: sealed.origin,
      bearer: sealer.bearer(sealed.lookupKey),
      accessHeaders: sealed.accessHeaders,
      expiresAt: sealed.expiresAt,
    };
  }

  function sealedHandle(by: Sealer, sealed: SealedSandbox): RuntimeHandle {
    return handleOf(by.seal(sealed), sealed);
  }

  function assertLive(runtime: RuntimeHandle, operation: string): LiveSandbox {
    const known = lookup(runtime.id);
    if (known === undefined || known.handle.externalId !== runtime.externalId) {
      throw new Error(
        `${driverId} runtime: cannot ${operation}; handle ${JSON.stringify(runtime.id)} was not created by this driver or is no longer live.`,
      );
    }
    return known;
  }

  return { live, lookup, sealedHandle, assertLive };
}
