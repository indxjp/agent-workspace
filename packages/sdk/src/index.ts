/**
 * `@indx-workspace/sdk` — a typed client for the Agent Workspace control-plane API.
 *
 * ```ts
 * import { createClient } from '@indx-workspace/sdk';
 *
 * const workspace = createClient({
 *   baseUrl: 'https://agents.example.com',
 *   auth: { kind: 'api-key', apiKey: process.env.AGENT_WORKSPACE_API_KEY },
 * });
 *
 * const { run } = await workspace.runs.start(agentId, { prompt: 'Summarise the open incidents.' });
 * for await (const frame of workspace.runs.follow(run.id)) {
 *   if (frame.kind === 'runtime') render(frame.data);
 * }
 * ```
 *
 * The client is isomorphic: it uses the Web platform's `fetch`, `Headers`, `URL`, `AbortSignal`
 * and `ReadableStream`, and nothing from Node. Every response is validated against
 * `@indx-workspace/contracts` before it is returned, and every failure is one of four typed
 * errors — {@link ApiProblemError}, {@link ContractViolationError}, {@link TransportError}, and
 * {@link InvalidArgumentError} for an argument refused before any request — so calling code
 * branches on `kind`/`status`/`code`, never on prose.
 */
import type { MeResponse } from '@indx-workspace/contracts/team';

import { HttpClient, type ClientOptions, type RequestOptions } from './http.js';
import { readMe } from './me.js';
import { AgentsClient } from './resources/agents.js';
import { ConnectorsClient } from './resources/connectors.js';
import { EndpointClientsClient } from './resources/endpointClients.js';
import { EnginesClient } from './resources/engines.js';
import { PlatformsClient } from './resources/platforms.js';
import { FilesClient } from './resources/files.js';
import { ModelsClient } from './resources/models.js';
import { ObservabilityClient } from './resources/observability.js';
import { ProjectsClient } from './resources/projects.js';
import { RunsClient } from './resources/runs.js';
import { RuntimesClient } from './resources/runtimes.js';
import { SecretsClient } from './resources/secrets.js';
import { SessionsClient } from './resources/sessions.js';
import { SharesClient } from './resources/shares.js';
import { SkillsClient } from './resources/skills.js';
import { ToolBundlesClient } from './resources/toolBundles.js';
import { TeamClient } from './resources/team.js';
import { AuthClient } from './resources/auth.js';
import { TokensClient } from './resources/tokens.js';
import { WorkspacesClient } from './resources/workspaces.js';

export type { ClientAuth, ClientOptions, RequestOptions } from './http.js';
export {
  AgentWorkspaceError,
  ApiProblemError,
  ContractsVersionUnsupportedError,
  ContractViolationError,
  InvalidArgumentError,
  TransportError,
  type ContractsVersionSkew,
} from './errors.js';
export { readContractsVersionSkew } from './version.js';
export type {
  ImportAgentDefinitionOptions,
  ImportAgentDefinitionResult,
} from './resources/agent-definitions.js';
export type { AgentPointersClient, AgentVersionsClient } from './resources/agent-versions.js';
export type { AgentsClient } from './resources/agents.js';
export type { EvaluationsClient } from './resources/evaluations.js';
export type { ConnectorsClient, ToolConnectorBody } from './resources/connectors.js';
export type { EndpointClientsClient } from './resources/endpointClients.js';
export type { EnginesClient } from './resources/engines.js';
export type {
  PlatformArchive,
  PlatformExportTarget,
  PlatformsClient,
} from './resources/platforms.js';
export type {
  FileDownload,
  FilesClient,
  ListFilesQuery,
  RemoveFileOptions,
  UploadBody,
  UploadFileOptions,
} from './resources/files.js';
export type { ModelConnectionsClient, ModelsClient } from './resources/models.js';
export type { AuditClient, MetricsClient, ObservabilityClient } from './resources/observability.js';
export type {
  ListProjectsQuery,
  ProjectsClient,
  StartProjectSessionInput,
} from './resources/projects.js';
export type {
  FollowRunOptions,
  RunEventsOptions,
  RunStreamEnd,
  RunsClient,
  StartRunInput,
} from './resources/runs.js';
export { runFailure } from './resources/runs.js';
export type {
  RuntimeConnectionsClient,
  RuntimeProfilesClient,
  RuntimesClient,
} from './resources/runtimes.js';
export type { SecretsClient } from './resources/secrets.js';
export type {
  ListSessionsQuery,
  ReadTranscriptOptions,
  SessionTranscriptClient,
  SessionsClient,
  TranscriptAddress,
} from './resources/sessions.js';
export type { SharesClient } from './resources/shares.js';
export type { SkillsClient } from './resources/skills.js';
export type { ToolBundlesClient } from './resources/toolBundles.js';
export type {
  ApiKeysClient,
  InvitationsClient,
  MembersClient,
  TeamClient,
  UsersClient,
} from './resources/team.js';
export type { AuthClient } from './resources/auth.js';
export type { MintTokenOptions, TokensClient } from './resources/tokens.js';
export type { SharingPolicyClient, WorkspacesClient } from './resources/workspaces.js';
export type { RunEventFrame } from './events/run-events.js';
export type { MeResponse } from '@indx-workspace/contracts/team';

/**
 * One authenticated connection to a control plane, with a client per resource family — and one
 * operation of its own, {@link AgentWorkspaceClient.me}, which belongs to no family.
 */
export interface AgentWorkspaceClient {
  /**
   * Who this credential is: `{ principalId, kind, role, workspaceId, userId, label }`.
   *
   * Every consumer's first call. An API key is bound to one workspace and carries no membership
   * to list, so this is the only way it can name the workspace and role it was authorised under;
   * a session caller additionally learns its `userId` and a human label. `userId` is `null` for
   * exactly an API-key principal.
   */
  me(options?: RequestOptions): Promise<MeResponse>;
  readonly workspaces: WorkspacesClient;
  readonly agents: AgentsClient;
  readonly runs: RunsClient;
  readonly sessions: SessionsClient;
  readonly projects: ProjectsClient;
  readonly secrets: SecretsClient;
  readonly runtimes: RuntimesClient;
  readonly models: ModelsClient;
  readonly files: FilesClient;
  readonly skills: SkillsClient;
  /** `/api/tool-bundles` — issue #790 (ADR-0118 TS1): content-addressed code-tool bundles. */
  readonly toolBundles: ToolBundlesClient;
  readonly connectors: ConnectorsClient;
  /**
   * `GET /api/engines` — issue #319 (ENG-02c): the engines this deployment can run an agent on.
   *
   * The catalogue every engine-aware decision is taken against: which `engine` an agent policy may
   * name, and what that engine can honour of the portable configuration.
   */
  readonly engines: EnginesClient;
  /**
   * `/api/platforms` — issue #968 (ADR-0133): the external agent platforms a saved agent version
   * can be exported to, and that export as files with a per-field verdict report.
   */
  readonly platforms: PlatformsClient;
  /** `/api/endpoint-clients` — issue #949, ADR-0134: what an external platform may reach, and its keys. */
  readonly endpointClients: EndpointClientsClient;
  readonly team: TeamClient;
  readonly shares: SharesClient;
  readonly observability: ObservabilityClient;
  /** `POST /api/tokens` — issue #236 (SDK-04, S-1): mint a browser token. */
  readonly tokens: TokensClient;
  /** `/api/auth/cli-*` — issue #242 (SDK-10, S-22): device sign-in and sign-out for a person. */
  readonly auth: AuthClient;
}

export function createClient(options: ClientOptions): AgentWorkspaceClient {
  const http = new HttpClient(options);
  return {
    me: (requestOptions: RequestOptions = {}) => readMe(http, requestOptions),
    workspaces: new WorkspacesClient(http),
    agents: new AgentsClient(http),
    runs: new RunsClient(http),
    sessions: new SessionsClient(http),
    projects: new ProjectsClient(http),
    secrets: new SecretsClient(http),
    runtimes: new RuntimesClient(http),
    models: new ModelsClient(http),
    files: new FilesClient(http),
    skills: new SkillsClient(http),
    toolBundles: new ToolBundlesClient(http),
    connectors: new ConnectorsClient(http),
    engines: new EnginesClient(http),
    platforms: new PlatformsClient(http),
    endpointClients: new EndpointClientsClient(http),
    team: new TeamClient(http),
    shares: new SharesClient(http),
    observability: new ObservabilityClient(http),
    tokens: new TokensClient(http),
    auth: new AuthClient(http),
  };
}
