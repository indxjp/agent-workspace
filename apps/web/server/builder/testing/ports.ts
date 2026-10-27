import { MemoryApproval } from '../adapters/approval/memory';
import { MemoryAudit } from '../adapters/audit/memory';
import { MemoryAuthorization } from '../adapters/authorization/memory';
import { MemoryCatalog } from '../adapters/catalog/memory';
import { MemoryChecker } from '../adapters/checker/memory';
import { MemoryPolicy } from '../adapters/policy/memory';
import { MemoryRunner } from '../adapters/runner/memory';
import { MemoryAgentStore } from '../adapters/store/memory';
import type { BuilderPorts } from '../tools/types';

/** Resolves every door to the Builder, so a test about something else need not register an agent. */
export class BuilderAuthorization extends MemoryAuthorization {
  override creator: MemoryAuthorization['creator'] = () => Promise.resolve({ kind: 'builder' });
}

/** Every Builder port in memory, switched on, with no agents, connectors or catalog entries unless a test overrides one. */
export function makeMemoryPorts(overrides: Partial<BuilderPorts> = {}): BuilderPorts {
  return {
    feature: { enabled: () => Promise.resolve(true) },
    approval: new MemoryApproval(),
    authorization: new BuilderAuthorization(),
    policy: new MemoryPolicy(),
    checker: new MemoryChecker(new Set(), new Map()),
    store: new MemoryAgentStore(),
    runner: new MemoryRunner(),
    catalog: new MemoryCatalog([]),
    audit: new MemoryAudit(),
    clock: () => new Date(),
    ...overrides,
  };
}
