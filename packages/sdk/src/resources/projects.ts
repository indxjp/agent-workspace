import {
  ProjectListResponseSchema,
  ProjectResourceSchema,
  ProjectSessionMoveResponseSchema,
  ProjectSessionResponseSchema,
  type ProjectCreateInput,
  type ProjectListFilter,
  type ProjectPatchInput,
  type ProjectResource,
  type ProjectSessionMoveResponse,
  type ProjectSessionResponse,
} from '@indx-workspace/contracts/projects';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

export interface ListProjectsQuery {
  /** `active` (the default), `archived`, or `all`. */
  readonly archived?: ProjectListFilter;
}

export interface StartProjectSessionInput {
  /** Omit to use the project's default agent. */
  readonly agentId?: string;
}

/** `/api/projects/**` — spec §20.5. */
export class ProjectsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  public async list(
    query: ListProjectsQuery = {},
    options: RequestOptions = {},
  ): Promise<readonly ProjectResource[]> {
    const params = new URLSearchParams();
    if (query.archived !== undefined) params.set('archived', query.archived);
    const response = await this.#http.json({
      operation: 'projects.list',
      method: 'GET',
      path: '/api/projects',
      query: params,
      expect: [200],
      schema: ProjectListResponseSchema,
      signal: options.signal,
    });
    return response.projects;
  }

  public async get(projectId: string, options: RequestOptions = {}): Promise<ProjectResource> {
    return this.#http.json({
      operation: 'projects.get',
      method: 'GET',
      path: `/api/projects/${segment(projectId)}`,
      expect: [200],
      schema: ProjectResourceSchema,
      signal: options.signal,
    });
  }

  public create(input: ProjectCreateInput, options: RequestOptions = {}): Promise<ProjectResource> {
    return this.#http.json({
      operation: 'projects.create',
      method: 'POST',
      path: '/api/projects',
      body: input,
      expect: [201],
      schema: ProjectResourceSchema,
      signal: options.signal,
    });
  }

  public async update(
    projectId: string,
    patch: ProjectPatchInput,
    options: RequestOptions = {},
  ): Promise<ProjectResource> {
    return this.#http.json({
      operation: 'projects.update',
      method: 'PATCH',
      path: `/api/projects/${segment(projectId)}`,
      body: patch,
      expect: [200],
      schema: ProjectResourceSchema,
      signal: options.signal,
    });
  }

  /** Retire a project: it keeps its history and accepts no new session. Idempotent. */
  public async archive(projectId: string, options: RequestOptions = {}): Promise<ProjectResource> {
    return this.#transition('archive', projectId, options);
  }

  public async restore(projectId: string, options: RequestOptions = {}): Promise<ProjectResource> {
    return this.#transition('restore', projectId, options);
  }

  #transition(
    action: 'archive' | 'restore',
    projectId: string,
    options: RequestOptions,
  ): Promise<ProjectResource> {
    return this.#http.json({
      operation: `projects.${action}`,
      method: 'POST',
      path: `/api/projects/${segment(projectId)}/${action}`,
      expect: [200],
      schema: ProjectResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Open a session attributed to the project before its first run, so the run's project
   * attribution is set at creation and never rewritten. Pass the returned `id` as `sessionId`
   * when starting the run.
   */
  public async startSession(
    projectId: string,
    input: StartProjectSessionInput = {},
    options: RequestOptions = {},
  ): Promise<ProjectSessionResponse> {
    return this.#http.json({
      operation: 'projects.startSession',
      method: 'POST',
      path: `/api/projects/${segment(projectId)}/sessions`,
      body: input.agentId === undefined ? {} : { agentId: input.agentId },
      expect: [200, 201],
      schema: ProjectSessionResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Move an existing session into the project. The same route as {@link startSession}: a body
   * naming a `sessionId` moves instead of starting. Refused with `409 project_session_has_runs`
   * once the session has any run, with `409 project_archived` for a retired destination, and
   * with `403 forbidden` when the caller may not edit the session's current project.
   */
  public async adoptSession(
    projectId: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<ProjectSessionMoveResponse> {
    return this.#http.json({
      operation: 'projects.adoptSession',
      method: 'POST',
      path: `/api/projects/${segment(projectId)}/sessions`,
      body: { sessionId },
      expect: [200],
      schema: ProjectSessionMoveResponseSchema,
      signal: options.signal,
    });
  }
}
