/**
 * The sidebar's recent chats (spec §44, UX-05 in #2086): the signed-in person's own active sessions,
 * newest first, about ten. Navigation, not a feature area: no filters, folders or tags.
 *
 * "Own" is decided by the repository's `owner` visibility for the membership's principal, so an
 * Owner or Admin sees only their own chats here even though the sessions API lets them list every
 * session in the workspace.
 */
import { applicationContext } from '../application-context';
import { log } from '../telemetry/logger';

/** About ten, as §44 says. */
export const RECENT_CHAT_LIMIT = 10;

/** One row of the list, already labelled. */
export interface RecentChatEntry {
  readonly id: string;
  /** The session's title, or its agent's name when it has none; `null` when neither is known. */
  readonly label: string | null;
}

/** The person whose chats are listed: their workspace and their membership principal. */
export interface RecentChatsOwner {
  readonly workspaceId: string;
  readonly principalId: string;
}

/**
 * The owner's recent chats, or `[]` when nothing is wired or the read fails: the list is a
 * convenience beside the navigation, so a failure is logged and the sidebar still renders.
 */
export async function recentChatsFor(owner: RecentChatsOwner): Promise<readonly RecentChatEntry[]> {
  const context = applicationContext();
  if (context === null) return [];
  try {
    const sessions = await context.sessions.sessions.forWorkspaceId(owner.workspaceId);
    if (sessions === null) return [];
    const page = await sessions.list({
      visibility: { kind: 'owner', principalId: owner.principalId },
      status: 'active',
      limit: RECENT_CHAT_LIMIT,
      cursor: null,
    });
    const agents = context.agents.agents.forWorkspace(owner.workspaceId);
    const names = new Map<string, string>();
    // A built-in agent's sessions (the Builder's) are not chats the home composer can continue:
    // it never offers those agents, so their sessions are left out rather than listed and refused.
    const builtin = new Set<string>();
    for (const agentId of new Set(page.items.map((session) => session.agentId))) {
      const agent = await agents.get(agentId);
      if (agent === null) continue;
      if (agent.builtin !== undefined) builtin.add(agentId);
      else names.set(agentId, agent.name);
    }
    return page.items
      .filter((session) => !builtin.has(session.agentId))
      .map((session) => ({
        id: session.id,
        label: session.title ?? names.get(session.agentId) ?? null,
      }));
  } catch (error) {
    log.error('[sessions] the recent chats could not be read', { error });
    return [];
  }
}
