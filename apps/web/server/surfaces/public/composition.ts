/**
 * The PostgreSQL {@link SurfaceSessionsRuntime} (ADR-0105 slice 1; S1-17, issue #455): which
 * surface a name resolves to, and how a session for it is opened. `register.ts` builds it from
 * the objects it already holds for the run API and `POST /api/tokens`, so this file reads and
 * writes through the same seams those routes do.
 *
 * - **Workspace.** A `/p/s/<name>` URL names no workspace, so the deployment's workspace
 *   (`WORKSPACE_SLUG`, default `default`) is the one served; no bootstrap credential is needed. A
 *   surface in any other workspace of the same deployment is not found.
 * - **Environment (issue #612).** {@link pickSurfaceVersion} decides which pointer serves a name:
 *   `/p/s/<name>` and the widget serve `production`, or `local` while the agent has no
 *   `production` pointer; the try page always serves `local`. A new session of the surface's agent
 *   pins the version that pick resolved (issue #622), one of an offered agent the version its
 *   environment points at, and is preflighted against that version. A visitor's limits are read
 *   from the surface its session pinned.
 * - **Publisher.** The session and its token belong to the owner of the agent whose pointed
 *   version serves the surface, re-read from the directory as a full principal.
 * - **No empty sessions.** The workspace gate and the run preflight run before the session row is
 *   written (PR #403), so a refused first message leaves nothing behind.
 * - **Switching agents (SD8).** A visitor may name another agent the surface's `agentSwitcher`
 *   offers. It must have the surface agent's owner and a pointer in the environment the same rule
 *   picks for it, checked on every call,
 *   and its session is opened as that owner after its own preflight. A session is bound to one
 *   agent (`sessions.agent_id`), so switching opens or resumes a different session.
 * - **Resuming (C18).** A fresh session gets a resume key, stored as a SHA-256 digest with the
 *   surface and agent it was issued for. A resume must match all three and the session must be
 *   live; an unknown session, a wrong key and another agent's session answer alike. A resume
 *   mints a fresh token and leaves earlier ones to expire on their own.
 */
import { log } from '../../telemetry/logger';
import type {
  AgentVersionEnvironment,
  AgentVersionPointerRecord,
  AgentVersionRecord,
  AgentVersionRepository,
  DirectoryPrincipalRecord,
  PointedSurface,
  SessionRepository,
  SurfaceSessionKeyRepository,
  WorkspaceScope,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import {
  SURFACE_SESSION_TTL_SECONDS,
  SurfaceAllowedOriginsSchema,
  SurfaceDefinitionSchema,
  type SurfaceDefinition,
  type SurfaceSessionRequest,
} from '@indx-workspace/contracts/surfaces';

import { versionToPin } from '../../agent-versions/session-version';
import type { AgentRecord } from '../../agents/contract';
import type { WorkspaceAgentStore } from '../../agents/store';
import { readDeploymentWorkspaceSlug } from '../../auth/session';
import { engineForStoredPolicy } from '../../engines/session-engine';
import { hashApiKeySecret, hashesEqual, randomToken } from '../../rbac/api-key';
import { Principal } from '../../rbac/principal';
import type { AgentRef, RunApiEnvironment } from '../../runs/environment';
import type { TokensRuntime } from '../../tokens/runtime';
import type { RunGate } from '../../workspaces/run-gate';
import {
  surfaceModeOf,
  type ResolvedSurface,
  type ServedSurface,
  type SurfaceMode,
  type SurfaceModelRefusal,
  type SurfaceSessionOpening,
  type SurfaceSessionsRuntime,
  type VisitorSurface,
} from './runtime';

/**
 * The environment a session of an agent with `pointers` runs from for `mode` (issue #612): the
 * public is served `production` once the agent has that pointer, else `local`; the try page is
 * always served `local`.
 */
export function surfaceEnvironment(
  mode: SurfaceMode,
  pointers: readonly AgentVersionPointerRecord[],
): AgentVersionEnvironment {
  return mode === 'public' && pointers.some((pointer) => pointer.environment === 'production')
    ? 'production'
    : 'local';
}

/** What {@link pickSurfaceVersion} picked. */
export interface PickedSurface {
  readonly environment: AgentVersionEnvironment;
  readonly pointed: PointedSurface;
  /** Whether the serving agent has a `production` pointer. */
  readonly promoted: boolean;
}

/**
 * The pointed version that serves surface `name` to `mode` (issue #612), by
 * {@link surfaceEnvironment}: for the public, the `production` version carrying it, else the
 * `local` one of an agent not promoted yet. An agent promoted to a version without the surface
 * does not serve its draft's surface to the public: `null`, as for a name no version carries.
 */
export async function pickSurfaceVersion(
  versions: Pick<AgentVersionRepository, 'findPointedSurface' | 'list'>,
  name: string,
  mode: SurfaceMode,
): Promise<PickedSurface | null> {
  if (mode === 'public') {
    const production = await versions.findPointedSurface('production', name);
    if (production !== null) {
      return { environment: 'production', pointed: production, promoted: true };
    }
  }
  const local = await versions.findPointedSurface('local', name);
  if (local === null) return null;
  // ponytail: `list` reads every version body for its pointers; add a pointer-only read if agents
  // collect enough versions for a surface lookup to notice.
  const pointers = (await versions.list(local.agentId))?.pointers ?? [];
  if (surfaceEnvironment(mode, pointers) !== 'local') return null;
  return {
    environment: 'local',
    pointed: local,
    promoted: pointers.some((pointer) => pointer.environment === 'production'),
  };
}

export interface SurfaceSessionsDependencies {
  /** The process environment, read on every call so the deployment workspace is never stale. */
  readonly env: () => Readonly<Record<string, string | undefined>>;
  readonly scopes: Pick<WorkspaceScopeResolver, 'forWorkspaceId' | 'forWorkspaceSlug'>;
  readonly agentVersions: {
    forScope(
      scope: WorkspaceScope,
    ): Pick<
      AgentVersionRepository,
      'findById' | 'findPointedSurface' | 'list' | 'listPointedSurfaceNames'
    >;
  };
  readonly agents: {
    forWorkspace(workspaceId: string): Pick<WorkspaceAgentStore, 'get' | 'list'>;
  };
  readonly principalById: (
    workspaceId: string,
    principalId: string,
  ) => Promise<DirectoryPrincipalRecord | null>;
  readonly sessions: {
    forScope(scope: WorkspaceScope): Pick<SessionRepository, 'ensure' | 'get'>;
  };
  readonly surfaceSessionKeys: { forScope(scope: WorkspaceScope): SurfaceSessionKeyRepository };
  readonly runGate: RunGate;
  /**
   * The run API's own preflight, so the bootstrap refuses exactly what a first run would: a
   * resumed session (`sessionId`) is checked against its pinned version, a new one against
   * `versionId`, the version it will pin (`null`: a legacy agent's row).
   */
  readonly preflight: (
    publisher: Principal,
    agent: AgentRef,
    sessionId: string | null,
    versionId: string | null,
  ) => ReturnType<NonNullable<RunApiEnvironment['preflight']>>;
  /** The installed `POST /api/tokens` runtime, whose `issue` mints the session's token. */
  readonly tokens: () => Pick<TokensRuntime, 'issue'> | null;
}

const GONE: SurfaceSessionOpening = { kind: 'gone' };
const AGENT_NOT_OFFERED: SurfaceSessionOpening = { kind: 'agent-not-offered' };
const NOT_RESUMABLE: SurfaceSessionOpening = { kind: 'not-resumable' };

/** The bytes of CSPRNG entropy in a resume key: 43 base64url characters (C18). */
const RESUME_KEY_BYTES = 32;

/**
 * The agent a bootstrap talks to: the surface's own, or one its `agentSwitcher` offers that has
 * the same owner and a pointer in the environment {@link surfaceEnvironment} picks for it (SD8),
 * with the version a new session of it pins. `null` when `name` is none of those.
 */
async function offeredAgent(
  dependencies: SurfaceSessionsDependencies,
  scope: WorkspaceScope,
  resolved: ResolvedSurface,
  mode: SurfaceMode,
  surfaceAgent: AgentRecord,
  name: string,
): Promise<{ readonly agent: AgentRecord; readonly versionId: string } | null> {
  // Issue #622: the surface's own agent pins the version {@link pickSurfaceVersion} resolved, whose
  // surface admitted this visitor; no second pick, so a promote in between cannot split them.
  if (name === surfaceAgent.name) return { agent: surfaceAgent, versionId: resolved.versionId };
  if (resolved.surface.parts?.agentSwitcher?.agents.includes(name) !== true) return null;
  // ponytail: linear scan of the workspace's agents per non-default switch, add a by-name lookup when surfaces leave loopback (S-2)
  const agent = (await dependencies.agents.forWorkspace(resolved.workspaceId).list()).find(
    (each) => each.name === name,
  );
  if (agent === undefined || agent.ownerPrincipalId !== surfaceAgent.ownerPrincipalId) {
    return null;
  }
  const listing = await dependencies.agentVersions.forScope(scope).list(agent.id);
  const pointers = listing?.pointers ?? [];
  const versionId = versionToPin(pointers, surfaceEnvironment(mode, pointers));
  return versionId === null ? null : { agent, versionId };
}

/** Surface `name` as version `record` carries it, or `undefined` when it carries none by that name. */
function surfaceOfVersion(record: AgentVersionRecord, name: string): SurfaceDefinition | undefined {
  const body = AgentVersionBodySchema.safeParse(record.body);
  return body.success ? body.data.surfaces.find((surface) => surface.name === name) : undefined;
}

/**
 * Set by `agent-workspace deploy` to the project's own deployed frontend origin: the domain Vercel
 * confirmed (ADR-0128) or the Cloudflare frontend Worker's `workers.dev` origin (ADR-0129).
 */
const FRONTEND_ORIGIN_VARIABLE = 'AW_FRONTEND_ORIGIN';

/**
 * `surface` with the deployment's own frontend origin among its `allowedOrigins` (ADR-0128), only
 * when it is served from `production`: a draft (`local`) is never widened, so the try page and an
 * agent not promoted yet keep exactly what they list. The value is `unknown` until the contract's
 * origin schema accepts it and it is `https:`; anything else, or a list already full, is ignored
 * with a warning each time a surface is resolved, never thrown at a visitor.
 */
export function withDeploymentOrigin(
  surface: SurfaceDefinition,
  environment: AgentVersionEnvironment,
  env: Readonly<Record<string, string | undefined>>,
): SurfaceDefinition {
  if (environment !== 'production') return surface;
  const origin = env[FRONTEND_ORIGIN_VARIABLE]?.trim() ?? '';
  if (origin === '') return surface;
  const listed = surface.allowedOrigins ?? [];
  if (listed.includes(origin)) return surface;
  const merged = SurfaceAllowedOriginsSchema.safeParse([...listed, origin]);
  if (!merged.success || !origin.startsWith('https://')) {
    log.warn(
      `[surfaces] ${FRONTEND_ORIGIN_VARIABLE} is not an https origin this surface can list, and is ignored.`,
    );
    return surface;
  }
  return { ...surface, allowedOrigins: merged.data };
}

/**
 * Whether `resume` names a live session of `agent` opened through this surface, with that key.
 * Every failed check gives the same `false`, so the answer never says which one failed.
 */
async function isResumable(
  dependencies: SurfaceSessionsDependencies,
  scope: WorkspaceScope,
  resolved: ResolvedSurface,
  agent: AgentRecord,
  resume: NonNullable<SurfaceSessionRequest['resume']>,
): Promise<boolean> {
  const key = await dependencies.surfaceSessionKeys.forScope(scope).find(resume.sessionId);
  if (key === null || key.surfaceName !== resolved.surface.name || key.agentId !== agent.id) {
    return false;
  }
  if (!hashesEqual(await hashApiKeySecret(resume.resumeKey), key.keyHash)) return false;
  const session = await dependencies.sessions.forScope(scope).get(resume.sessionId);
  return (
    session !== null &&
    session.status !== 'archived' &&
    session.agentId === agent.id &&
    session.ownerPrincipalId === agent.ownerPrincipalId
  );
}

/** The agent's owner as the principal a surface's runs act as, or `null` when it is gone. */
async function publisherOf(
  dependencies: SurfaceSessionsDependencies,
  workspaceId: string,
  agent: AgentRecord,
): Promise<{ readonly publisher: Principal; readonly agentRef: AgentRef } | null> {
  const record = await dependencies.principalById(workspaceId, agent.ownerPrincipalId);
  if (record === null) return null;
  return {
    publisher: Principal.fromDirectoryRecord({
      principalId: agent.ownerPrincipalId,
      kind: record.kind,
      workspaceId,
      role: record.role,
      label: record.label,
      userId: record.userId,
      apiKeyId: record.apiKeyId,
      actsForPrincipalId: record.actsForPrincipalId,
    }),
    agentRef: { id: agent.id, workspaceId, engine: engineForStoredPolicy(agent.policy) },
  };
}

/**
 * The scope of the workspace this deployment serves (`WORKSPACE_SLUG`), or `null` when the slug is
 * unusable or names no workspace. The one resolver behind the hosted surfaces and the A2A cards.
 */
export async function resolveDeploymentScope(
  env: Readonly<Record<string, string | undefined>>,
  scopes: Pick<WorkspaceScopeResolver, 'forWorkspaceSlug'>,
): Promise<WorkspaceScope | null> {
  const slug = readDeploymentWorkspaceSlug(env);
  return slug.ok ? scopes.forWorkspaceSlug(slug.slug) : null;
}

export function createSurfaceSessionsRuntime(
  dependencies: SurfaceSessionsDependencies,
): SurfaceSessionsRuntime {
  // Every hosted surface and A2A agent card answers "not found" for an unusable slug, which looks
  // like an empty deployment; say why once, at startup, rather than on every request.
  const deploymentSlug = readDeploymentWorkspaceSlug(dependencies.env());
  if (!deploymentSlug.ok) {
    log.warn(
      `[surfaces] ${deploymentSlug.reason} Every hosted surface and A2A agent card will answer "not found" until it is fixed.`,
    );
  }
  const runtime: SurfaceSessionsRuntime = {
    async resolve(name: string, mode: SurfaceMode): Promise<ResolvedSurface | null> {
      const scope = await resolveDeploymentScope(dependencies.env(), dependencies.scopes);
      if (scope === null) return null;
      const picked = await pickSurfaceVersion(
        dependencies.agentVersions.forScope(scope),
        name,
        mode,
      );
      if (picked === null) return null;
      const { pointed } = picked;
      const surface = SurfaceDefinitionSchema.safeParse(pointed.surface);
      if (!surface.success) {
        // Every saved surface was parsed on the way in; one that no longer parses was written by
        // an older contract. It is not served, and the log names it so it can be re-saved.
        log.error(
          `[surfaces] the surface "${name}" of agent ${pointed.agentId} version ` +
            `${String(pointed.number)} no longer parses and is not served: ${surface.error.message}`,
        );
        return null;
      }
      const agent = await dependencies.agents.forWorkspace(scope.workspaceId).get(pointed.agentId);
      if (agent === null) return null;
      return {
        workspaceId: scope.workspaceId,
        agentId: agent.id,
        agentName: agent.name,
        environment: picked.environment,
        versionId: pointed.versionId,
        versionNumber: pointed.number,
        promoted: picked.promoted,
        surface: withDeploymentOrigin(surface.data, picked.environment, dependencies.env()),
      };
    },

    async open(
      resolved: ResolvedSurface,
      request: SurfaceSessionRequest,
    ): Promise<SurfaceSessionOpening> {
      const { workspaceId } = resolved;
      // Issue #119: an archived workspace takes no new session, checked before anything is read.
      if (!(await dependencies.runGate.isUsable(workspaceId))) return GONE;
      const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
      if (scope === null) return GONE;
      const surfaceAgent = await dependencies.agents
        .forWorkspace(workspaceId)
        .get(resolved.agentId);
      if (surfaceAgent === null) return GONE;
      const offered = await offeredAgent(
        dependencies,
        scope,
        resolved,
        surfaceModeOf(request),
        surfaceAgent,
        request.agent ?? surfaceAgent.name,
      );
      if (offered === null) return AGENT_NOT_OFFERED;
      const { agent, versionId } = offered;
      const { resume } = request;
      if (
        resume !== undefined &&
        !(await isResumable(dependencies, scope, resolved, agent, resume))
      ) {
        return NOT_RESUMABLE;
      }
      const owner = await publisherOf(dependencies, workspaceId, agent);
      if (owner === null) return GONE;
      const { publisher, agentRef } = owner;
      // A resumed session's project, if it was filed under one, decides its model as a run's would.
      const refusal = await dependencies.preflight(
        publisher,
        agentRef,
        resume?.sessionId ?? null,
        versionId,
      );
      if (refusal !== null) {
        return { kind: 'refused', code: refusal.code, message: refusal.message };
      }
      const tokens = dependencies.tokens();
      if (tokens === null) {
        throw new Error(
          'the surface session bootstrap needs the tokens runtime, and none is installed',
        );
      }

      let sessionId: string;
      let resumeKey: string | null = null;
      if (resume === undefined) {
        const outcome = await dependencies.sessions.forScope(scope).ensure({
          id: crypto.randomUUID(),
          agentId: agent.id,
          ownerPrincipalId: publisher.ownerPrincipalId,
          userId: publisher.userId,
          // Issue #612: the conversation runs the version the surface's environment points at.
          agentVersionId: versionId,
        });
        if (outcome.kind !== 'created' && outcome.kind !== 'existing') {
          log.error(
            `[surfaces] no session could be opened for agent ${agent.id}: ${outcome.kind}.`,
          );
          return GONE;
        }
        sessionId = outcome.session.id;
        resumeKey = randomToken(RESUME_KEY_BYTES);
        // ponytail: two repositories, no shared transaction; a failed key insert leaves a session nobody can resume and answers 5xx, share one transaction if that is ever seen
        await dependencies.surfaceSessionKeys.forScope(scope).record({
          sessionId,
          surfaceName: resolved.surface.name,
          agentId: agent.id,
          keyHash: await hashApiKeySecret(resumeKey),
        });
      } else {
        sessionId = resume.sessionId;
      }
      const minted = await tokens.issue(
        publisher,
        { kind: 'session', id: sessionId },
        SURFACE_SESSION_TTL_SECONDS,
      );
      // `issue` refuses a session that went away after the checks above (e.g. archived after
      // `isResumable`): a resume answers as any other unresumable session, not as a gone surface.
      if (minted === null) return resume === undefined ? GONE : NOT_RESUMABLE;
      return {
        kind: 'opened',
        sessionId,
        agentId: agent.id,
        token: minted.token,
        expiresAt: minted.expiresAt,
        resumeKey,
      };
    },

    async checkModel(resolved: ResolvedSurface): Promise<SurfaceModelRefusal | null> {
      const { workspaceId } = resolved;
      if (!(await dependencies.runGate.isUsable(workspaceId))) return null;
      const agent = await dependencies.agents.forWorkspace(workspaceId).get(resolved.agentId);
      if (agent === null) return null;
      const owner = await publisherOf(dependencies, workspaceId, agent);
      if (owner === null) return null;
      const refusal = await dependencies.preflight(
        owner.publisher,
        owner.agentRef,
        null,
        resolved.versionId,
      );
      return refusal === null ? null : { code: refusal.code, message: refusal.message };
    },

    async visitorSurface(workspaceId: string, sessionId: string): Promise<VisitorSurface | null> {
      const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
      if (scope === null) return null;
      const key = await dependencies.surfaceSessionKeys.forScope(scope).find(sessionId);
      if (key === null) return null;
      // Issue #622: the surface of the version the session pinned, so a promote moves neither the
      // conversation's version nor its limits.
      const pinned = (await dependencies.sessions.forScope(scope).get(sessionId))?.agentVersionId;
      const version =
        pinned === undefined || pinned === null
          ? null
          : await dependencies.agentVersions.forScope(scope).findById(pinned);
      const surface = version === null ? undefined : surfaceOfVersion(version, key.surfaceName);
      // The pinned surface is read as served: here the origin only adds a limit (the default turn
      // cap), so a draft's visitor session meets a stricter cap and never a looser one.
      if (surface !== undefined)
        return { surface: withDeploymentOrigin(surface, 'production', dependencies.env()) };
      // ponytail: a switcher session pins its own agent's version, which carries no such surface,
      // so it reads the surface the public is served now; record the surface's version with the
      // key if a switched conversation must keep its limits across a promote.
      const resolved = await runtime.resolve(key.surfaceName, 'public');
      return { surface: resolved?.workspaceId === workspaceId ? resolved.surface : null };
    },

    async servedSurfaces(): Promise<readonly ServedSurface[]> {
      const scope = await resolveDeploymentScope(dependencies.env(), dependencies.scopes);
      if (scope === null) return [];
      const names = await dependencies.agentVersions.forScope(scope).listPointedSurfaceNames();
      // ponytail: one names query plus a resolve per surface on every cross-origin run call;
      // cache it per request or with a short TTL if it shows up in latency.
      const resolved = await Promise.all(names.map((name) => runtime.resolve(name, 'public')));
      return resolved.flatMap((served) =>
        served === null ? [] : [{ ...served.surface, servedFrom: served.environment }],
      );
    },
  };
  return runtime;
}
