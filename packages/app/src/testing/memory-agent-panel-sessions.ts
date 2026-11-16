/**
 * `memoryAgentPanelSessions`: the in-memory twin of `agentPanelSessionsOf` (issue #1509), with the
 * same port and the same keying, for tests and the fixture app: sessions per record, agent and
 * person, never overwritten, the latest one found.
 */
import type { AgentPanelKey, AgentPanelSessionStore } from '../db/agent-panel-sessions.js';

/** The in-memory sessions, and how many there are, for a test to look at. */
export interface MemoryAgentPanelSessions extends AgentPanelSessionStore {
  readonly size: number;
}

interface Kept {
  readonly key: AgentPanelKey;
  readonly sessionId: string;
  readonly order: number;
}

function keyOf(key: AgentPanelKey): string {
  return JSON.stringify([
    key.workspaceId,
    key.resource,
    key.recordId.toLowerCase(),
    key.agent,
    key.principalId,
  ]);
}

/** Empty sessions, held in this process only. */
export function memoryAgentPanelSessions(): MemoryAgentPanelSessions {
  const sessions = new Map<string, Kept>();
  let order = 0;
  return {
    get size() {
      return sessions.size;
    },
    find(key) {
      const wanted = keyOf(key);
      let latest: Kept | undefined;
      for (const kept of sessions.values()) {
        if (keyOf(kept.key) === wanted && (latest === undefined || kept.order > latest.order)) {
          latest = kept;
        }
      }
      return Promise.resolve(latest?.sessionId ?? null);
    },
    save(key, sessionId) {
      order += 1;
      sessions.set(JSON.stringify([keyOf(key), sessionId]), { key, sessionId, order });
      return Promise.resolve();
    },
    sessionsOf(workspaceId, resource, recordId) {
      const wanted = recordId.toLowerCase();
      const found = [...sessions.values()]
        .filter(
          ({ key }) =>
            key.workspaceId === workspaceId &&
            key.resource === resource &&
            key.recordId.toLowerCase() === wanted,
        )
        .map(({ sessionId }) => sessionId);
      return Promise.resolve([...new Set(found)]);
    },
  };
}
