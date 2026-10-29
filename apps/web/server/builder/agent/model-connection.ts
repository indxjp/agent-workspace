/**
 * The model connection the Builder runs on (#1848). Its shipped body names the connection
 * `default` (contract C7), but first-run setup names the connection it makes
 * `<provider> default`. C7 binds `default` only to a connection literally named so, so on a fresh
 * install the Builder would be bound to no connection and every run refused with
 * `builder_model_unavailable`.
 *
 * The Builder's references therefore resolve in this order: the connection named `default`
 * (unchanged C7); else the connection setup makes for the provider of `BUILDER_MODEL`; else none,
 * which the run preflight still refuses. Only the Builder's resolution changes: C7 and every other
 * agent are untouched, and so is the shipped body, so the version hash stays the same.
 */
import type { SetupProvider } from '@indx-workspace/contracts/setup';

import type { DefinitionReferences, ResolveDefinitionOutcome } from '../../agent-versions/store';
import { setupConnectionName } from '../../setup/runtime';

/** The provider that serves `BUILDER_MODEL`, whose setup connection the Builder falls back to. */
const BUILDER_PROVIDER: SetupProvider = 'anthropic';

interface DefinitionResolver {
  resolveDefinition(references: DefinitionReferences): Promise<ResolveDefinitionOutcome>;
}

/** Resolve the Builder's references, falling back to setup's connection when C7 binds none. */
export async function resolveBuilderDefinition(
  store: DefinitionResolver,
  references: DefinitionReferences,
): Promise<ResolveDefinitionOutcome> {
  const outcome = await store.resolveDefinition(references);
  const namesDefault =
    references.modelConnectionName === null || references.modelConnectionName === 'default';
  if (outcome.kind !== 'resolved' || outcome.references.modelConnectionId !== null) return outcome;
  if (!namesDefault) return outcome;
  const setup = await store.resolveDefinition({
    ...references,
    modelConnectionName: setupConnectionName(BUILDER_PROVIDER),
  });
  // No setup connection either: keep C7's answer, so the preflight refuses as before.
  return setup.kind === 'resolved' ? setup : outcome;
}

/** `store` with the Builder's resolution, for the version pipeline that provisions the Builder. */
export function withBuilderConnection<S extends DefinitionResolver>(store: S): S {
  return {
    ...store,
    resolveDefinition: (references) => resolveBuilderDefinition(store, references),
  };
}
