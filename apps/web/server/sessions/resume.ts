/**
 * Whether `/?session=<id>` may continue that chat (UX-05 in #2086): the caller's own session, still
 * active, started by its engine, on an agent the composer offers this person. An Owner's or Admin's
 * oversight of other people's sessions (`canAccessSession`) does not extend to continuing them, so
 * ownership is compared here rather than delegated to that check.
 */
import { applicationContext } from '../application-context';
import { log } from '../telemetry/logger';
import { chatHistoryFor, type ChatHistory } from './history';

export type ResumeTarget =
  | {
      readonly kind: 'continue';
      readonly sessionId: string;
      readonly agentId: string;
      /** The session's title, or its agent's name when it has none. */
      readonly label: string;
      /** Its earlier messages, from the SDK transcript; `null` when they cannot be read. */
      readonly history: ChatHistory | null;
    }
  | { readonly kind: 'refused' };

const REFUSED: ResumeTarget = { kind: 'refused' };

/**
 * `offered` maps the agent ids the composer offers this person to their names. `request` carries the
 * caller's credentials; nothing in it but the session cookie is read.
 */
export async function resumeTargetFor(
  sessionId: string,
  request: Request,
  offered: ReadonlyMap<string, string>,
): Promise<ResumeTarget> {
  const env = applicationContext()?.sessions;
  if (env === undefined) return REFUSED;
  const principal = await env.authenticate(request);
  if (principal === null || principal.kind !== 'user') return REFUSED;
  const store = await env.sessions.forWorkspaceId(principal.workspaceId);
  const row = store === null ? null : await store.get(sessionId);
  if (
    row === null ||
    row.ownerPrincipalId !== principal.ownerPrincipalId ||
    row.status !== 'active' ||
    row.engineSessionId === null
  ) {
    return REFUSED;
  }
  const agentName = offered.get(row.agentId);
  if (agentName === undefined) return REFUSED;
  return {
    kind: 'continue',
    sessionId: row.id,
    agentId: row.agentId,
    label: row.title ?? agentName,
    history: await historyOrNull(env, row),
  };
}

/**
 * The earlier messages are a view: a transcript that cannot be read leaves the chat continuable
 * with the notice saying they are not shown, rather than failing the home page.
 */
async function historyOrNull(
  env: Parameters<typeof chatHistoryFor>[0],
  row: Parameters<typeof chatHistoryFor>[1],
): Promise<ChatHistory | null> {
  try {
    return await chatHistoryFor(env, row);
  } catch (error) {
    log.error(`[home] the earlier messages of session ${row.id} could not be read`, { error });
    return null;
  }
}
