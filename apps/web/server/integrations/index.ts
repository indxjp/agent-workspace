/**
 * The integrations context's public entry (refactoring plan part 04, step 7).
 *
 * Code in another context imports A2A, connectors, endpoints, the gateway, models, the tool endpoint,
 * triggers and webhooks from here, not from the folders underneath. `pnpm architecture:check`
 * enforces it: the `context-integrations-entered-through-its-entry` rule in
 * dependency-cruiser.config.mjs refuses a new deep import, and the deep imports that were left when
 * the rule landed are in .dependency-cruiser-known-violations.json, where they can only shrink.
 * Tests, `composition/` and the integrations context's own modules keep importing the modules
 * directly.
 *
 * Every type other contexts use is re-exported with `export type`, which loads nothing at run time.
 * Values are re-exported only from modules without start-up work: importing this file loads no
 * application context, no database driver, no object-store or cloud SDK, nothing Next.js-only and no
 * downstream context. These deep value imports stay, on purpose, and are in the baseline:
 *
 *   * `tool-endpoint/handler.ts` (`answerLocally`, `readCall`, `toolCallName`): it loads about 470
 *     modules, including the object-store SDKs, the database driver and the agents context.
 *   * `tool-endpoint/close.ts` (`closeEndpointToolSandbox`): it reads the application context.
 *   * `models/store.ts` (`createInMemoryModelsStoreProvider`, used by a run fixture): it loads the
 *     secret-manager SDKs and the database driver.
 *   * `oauth/resource.ts` (identity) and `runs/transcription.ts` (execution) are upstream of this
 *     context and import it against the direction; they stay deep so an upstream context does not
 *     load this entry. Moving that code is the real fix.
 *
 * No integrations module imports this file: that would be a cycle, and `no-circular-dependencies`
 * refuses it.
 */
export type {
  AnyConnectorResource,
  ConnectorResource,
  ToolConnectorResource,
} from '../connectors/contract';
export { listConnectors } from '../connectors/handlers';
export { CONNECTOR_IDENTITY_UNSUPPORTED } from '../connectors/identity';
export type {
  ConnectorsStoreProvider,
  WorkspaceConnectorsProbeSource,
  WorkspaceConnectorsStore,
} from '../connectors/store';
export { readPublicUrl } from '../endpoints/public-url';
export { endpointCredentialKey } from '../endpoints/request';
export type { RunTokenIssuer } from '../gateway/issuer';
export { verifyActiveRunToken, type RunTokenDatabase } from '../gateway/run-token-verifier';
export type { ModelConnectionResource } from '../models/contract';
export type { DeploymentDefaultModels } from '../models/deployment-default';
export { describeDiscoveryFailure, type ModelDiscovery } from '../models/discovery';
export { listModelConnections } from '../models/handlers';
export { selectPreferredModel } from '../models/preferred-model';
export type {
  ModelsStoreProvider,
  ResolvedModelConnection,
  WorkspaceModelsStore,
} from '../models/store';
export { admitToolEndpointCall } from '../tool-endpoint/limits';
