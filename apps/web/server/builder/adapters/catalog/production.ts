import type { RunOwnershipPrincipal } from '../../../agents/run-ownership';
import { listConnectors } from '../../../connectors/handlers';
import type { ConnectorsStoreProvider } from '../../../connectors/store';
import { listEngines } from '../../../engines/handlers';
import type { ApiResult } from '../../../http/result';
import { listModelConnections } from '../../../models/handlers';
import type { ModelsStoreProvider } from '../../../models/store';
import { listRuntimeProfiles } from '../../../runtimes/handlers';
import type { RuntimeProfileStoreProvider } from '../../../runtimes/store';
import type { CallContext, CatalogEntry, CatalogPort } from '../../ports';
import { readableKinds, type ListedKind } from './access';

export interface CatalogDependencies {
  readonly connectors: ConnectorsStoreProvider;
  readonly models: ModelsStoreProvider;
  readonly runtimeProfiles: RuntimeProfileStoreProvider;
  /** `listSkillsWithIds` bound to the workspace's stores; it writes catalog rows on read, as the console GET does. */
  readonly skills: (principal: RunOwnershipPrincipal) => Promise<ApiResult>;
}

/** The key each list handler wraps its rows in, and the row field that names one. */
const SHAPES = {
  engines: { key: 'engines', name: 'displayName' },
  models: { key: 'models', name: 'name' },
  skills: { key: 'skills', name: 'name' },
  connectors: { key: 'connectors', name: 'name' },
  runtimeProfiles: { key: 'runtimeProfiles', name: 'name' },
} as const satisfies Record<ListedKind, { key: string; name: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Rebuilds each row as `{kind, id, name}`; nothing else of a row is ever copied. */
function entriesOf(kind: ListedKind, result: ApiResult): CatalogEntry[] {
  const { key, name } = SHAPES[kind];
  const rows: unknown = isRecord(result.body) ? result.body[key] : undefined;
  if (result.status !== 200 || !Array.isArray(rows)) {
    throw new Error(`The ${kind} list answered ${String(result.status)} without a ${key} array.`);
  }
  return rows.map((row: unknown) => {
    const id = isRecord(row) ? row['id'] : undefined;
    const label = isRecord(row) ? row[name] : undefined;
    if (typeof id !== 'string' || typeof label !== 'string') {
      throw new Error(`A ${kind} row has no string id and ${name}.`);
    }
    return { kind, id, name: label };
  });
}

export function createCatalog(deps: CatalogDependencies): CatalogPort {
  const fetchKind = (
    kind: ListedKind,
    ctx: CallContext,
    principal: RunOwnershipPrincipal,
  ): Promise<ApiResult> => {
    switch (kind) {
      case 'engines':
        return Promise.resolve(listEngines());
      case 'models':
        return listModelConnections(deps.models.forWorkspace(ctx.workspaceId));
      case 'skills':
        return deps.skills(principal);
      case 'connectors':
        return listConnectors(deps.connectors.forWorkspace(ctx.workspaceId));
      case 'runtimeProfiles':
        return listRuntimeProfiles(deps.runtimeProfiles.forWorkspace(ctx.workspaceId));
    }
  };

  return {
    async list(ctx, kinds) {
      if (ctx.caller.kind === 'none') return [];
      const { principal } = ctx.caller;
      const entries: CatalogEntry[] = [];
      for (const kind of readableKinds(principal.role, kinds)) {
        entries.push(...entriesOf(kind, await fetchKind(kind, ctx, principal)));
      }
      return entries;
    },
  };
}
