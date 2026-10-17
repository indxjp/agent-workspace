/**
 * The seam between the hosted surface page and its local session bootstrap (ADR-0105 slice 1;
 * S1-17, issue #455) and the database layer that resolves a surface and opens a session — the
 * same globalThis registry shape as `../../tokens/runtime.ts`, installed by the composition root
 * (ADR-0038) and replaced by a fake in the handler tests.
 */
import type { AgentEnvironment } from '@indx-workspace/contracts/agent-versions';
import type { RunStartProblemCode } from '@indx-workspace/contracts/runs';
import type { SurfaceDefinition, SurfaceSessionRequest } from '@indx-workspace/contracts/surfaces';

/**
 * Who asks for a surface (issue #612): `public` is `/p/s/<name>` and the widget, served from
 * `production`, or from `local` while the agent has no `production` pointer; `try` is
 * `/p/s/<name>/try`, always served from `local`.
 */
export type SurfaceMode = 'public' | 'try';

/** The mode a session request asks for: `try` when the try page sends `environment: 'local'`. */
export function surfaceModeOf(request: SurfaceSessionRequest): SurfaceMode {
  return request.environment === 'local' ? 'try' : 'public';
}

/** The surface a name resolves to: the agent whose pointed version serves it (C9). */
export interface ResolvedSurface {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly agentName: string;
  /** The environment whose pointer serves the surface, and the version it points at. */
  readonly environment: AgentEnvironment;
  readonly versionId: string;
  readonly versionNumber: number;
  /** Whether the agent has a `production` pointer; the try page notes when it has none. */
  readonly promoted: boolean;
  readonly surface: SurfaceDefinition;
}

/**
 * A surface served to the public, with the environment whose version serves it (issue #699): only
 * the `local` draft gets the local default origins; an absent `servedFrom` never does.
 */
export type ServedSurface = SurfaceDefinition & { readonly servedFrom?: AgentEnvironment };

/** The run preflight's refusal of a surface's agent, as the try page shows it (issue #661). */
export interface SurfaceModelRefusal {
  readonly code: RunStartProblemCode;
  readonly message: string;
}

/** What opening a session for a resolved surface produced. */
export type SurfaceSessionOpening =
  | {
      readonly kind: 'opened';
      readonly sessionId: string;
      /** The agent the session talks to: the surface's own, or the offered one the visitor chose. */
      readonly agentId: string;
      readonly token: string;
      readonly expiresAt: Date;
      /** The new session's resume key, carried once; `null` when an earlier session resumed. */
      readonly resumeKey: string | null;
    }
  /** The run preflight refused the agent; no session was opened. */
  | { readonly kind: 'refused'; readonly code: RunStartProblemCode; readonly message: string }
  /** The workspace, agent or publisher went away, or is not usable for new work. */
  | { readonly kind: 'gone' }
  /** The requested agent is neither the surface's nor an offered one of the same owner (SD8). */
  | { readonly kind: 'agent-not-offered' }
  /** No session of this surface and agent matches the resume key, or it is archived (C18). */
  | { readonly kind: 'not-resumable' };

export interface SurfaceSessionsRuntime {
  /** The surface served under `name` to `mode`, or `null` when none is. */
  resolve(name: string, mode: SurfaceMode): Promise<ResolvedSurface | null>;
  /**
   * Open a new session, or resume the one `request.resume` names, of the surface's agent or the
   * offered one `request.agent` names, as that agent's owner, and mint a token scoped to it. A new
   * session of the surface's agent pins `resolved.versionId`; one of an offered agent pins the
   * version the same environment rule picks for it.
   * Every refusal is decided before anything is written, so a refused open leaves nothing.
   */
  open(resolved: ResolvedSurface, request: SurfaceSessionRequest): Promise<SurfaceSessionOpening>;
  /**
   * What the run preflight would refuse a first message to a new session of the surface's own
   * agent with, at `resolved.versionId`, or `null` when it would not (issue #661). Writes nothing
   * and mints no token; a workspace, agent or publisher that is gone answers `null`, because the
   * open that follows answers for it.
   */
  checkModel(resolved: ResolvedSurface): Promise<SurfaceModelRefusal | null>;
  /**
   * Whether session `sessionId` of workspace `workspaceId` was opened by this bootstrap (issue
   * #622): `null` when it was not, otherwise the surface it was opened on, as the version the
   * session pinned carries it; a session whose version carries none (a switched agent's) reads the
   * surface served now, whose `surface` is `null` when that surface is no longer served.
   */
  visitorSurface(workspaceId: string, sessionId: string): Promise<VisitorSurface | null>;
  /**
   * Every surface `/p/s/<name>` serves to the public now (issue #680): the origins the run routes
   * a visitor token may call answer CORS for are these surfaces' `allowedOrigins`.
   */
  servedSurfaces(): Promise<readonly ServedSurface[]>;
}

/** The surface a visitor session was opened on; `surface` is `null` once it is not served. */
export interface VisitorSurface {
  readonly surface: SurfaceDefinition | null;
}

interface Registry {
  __agentWorkspaceSurfaceSessionsRuntime__?: SurfaceSessionsRuntime;
}
const registry = globalThis as typeof globalThis & Registry;

export function configureSurfaceSessionsRuntime(runtime: SurfaceSessionsRuntime): void {
  registry.__agentWorkspaceSurfaceSessionsRuntime__ = runtime;
}

export function clearSurfaceSessionsRuntime(): void {
  delete registry.__agentWorkspaceSurfaceSessionsRuntime__;
}

export function currentSurfaceSessionsRuntime(): SurfaceSessionsRuntime | null {
  return registry.__agentWorkspaceSurfaceSessionsRuntime__ ?? null;
}
