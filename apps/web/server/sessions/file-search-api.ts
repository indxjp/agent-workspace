/**
 * `GET /api/sessions/:engineSessionId/file-search` — the run's own file search (ADR-0147, P8-4).
 *
 * A private runner route, like the `/state-*` family beside it: the only client is the agent's
 * `search_files` tool, with the signed per-run token. It answers from the paths the run was granted
 * when it launched, so an agent can quote nothing its run request did not carry. A browser user or
 * API key is refused 403; an unreachable session is 404, as on the state family.
 */
import { toResponse } from '../files/http';
import { invalidQuery, parseSearchQuery, searchWorkspaceFiles } from '../files/search-http';
import { apiError, json } from '../runs/http';
import { ready } from './api';
import { resolveSession } from './state-api';

export async function searchRunFiles(request: Request, pathId: string): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  const { principal, env } = state;
  if (principal.kind !== 'runner') {
    return apiError(403, 'session_forbidden', 'Only the run of a session searches its files here.');
  }
  const resolved = await resolveSession(state, pathId);
  if (!resolved.ok) return resolved.response;
  const query = parseSearchQuery(request);
  if (query === null) return toResponse(invalidQuery());
  const grants = await env.runFileGrants(principal.workspaceId, principal.runId);
  if (grants.length === 0) return json({ hits: [], pending: 0 }, 200);
  return toResponse(await searchWorkspaceFiles(request, principal.workspaceId, query, grants));
}
