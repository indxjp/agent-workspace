/**
 * ENG-06 · the engine-scoped session store · spec §20, §14.9 · issue #305.
 *
 * Seven private runner routes. None is printed in §34, so each carries a `mandate` citing §20 —
 * the section that says *"Implement a TypeScript `SessionStore` backed by durable storage"* and
 * lists **Resume session** among the operations the platform must support. §14.9 is the sentence
 * that makes it a release blocker, but `## 14.9` is a second-level heading and the gate's parser
 * reads only `# N` sections, so the checkable citation is §20 and the `because` line carries the
 * §14.9 claim (the same reading `W2-CP-07.ts` records for the transcript routes).
 *
 * W2-CP-07's four transcript routes are **not** re-declared here and are not removed: the Claude
 * tables stay, the two public reads (`GET …/transcript`, `…/subkeys`) now serve this store with the
 * legacy tables as their fallback, and the routes keep existing until the contract half of the
 * expand/contract lands (ADR-0071).
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/state-entries',
    owner: 'ENG-06-SESSION-STATE-305',
    landed: true,
    mandate: {
      section: '20',
      because:
        'the engine-neutral load(): §14.9 requires the durable store to persist "the Agent SDK session state, not only the session id", and a resume reads one stream of it back through this route, cursored.',
    },
  },
  {
    method: 'POST',
    path: '/api/sessions/:engineSessionId/state-entries',
    owner: 'ENG-06-SESSION-STATE-305',
    landed: true,
    mandate: {
      section: '20',
      because:
        'the engine-neutral append(): every engine mirrors its state batches to this route, idempotently by entryKey, which is what moves session state out of the sandbox for engines that are not Claude.',
    },
  },
  {
    method: 'PUT',
    path: '/api/sessions/:engineSessionId/state-entries',
    owner: 'ENG-06-SESSION-STATE-305',
    landed: true,
    mandate: {
      section: '20',
      because:
        'replace-all: the OpenAI Agents SDK clears a session and rewrites it, and doing that as two calls would leave a window in which §20’s resumable session has no history at all.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/sessions/:engineSessionId/state-entries',
    owner: 'ENG-06-SESSION-STATE-305',
    landed: true,
    mandate: {
      section: '20',
      because:
        'delete-last and delete-stream: §20 lists "Archive session" among the operations the platform must support, and the OpenAI Agents SDK’s popItem undoes exactly the last turn of a resumable one.',
    },
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/state-streams',
    owner: 'ENG-06-SESSION-STATE-305',
    landed: true,
    mandate: {
      section: '20',
      because:
        'the engine-neutral listSubkeys(): §20’s "Resume session" restores every stream a session has, and without this listing a resume restores the main one and loses the rest (R-01 §7).',
    },
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/state-blobs',
    owner: 'ENG-06-SESSION-STATE-305',
    landed: true,
    mandate: {
      section: '20',
      because:
        '§20’s durable store for an engine whose state is files rather than entries: an ACP agent replays its own state directory on session/load, so resuming one means reading that snapshot back.',
    },
  },
  {
    method: 'PUT',
    path: '/api/sessions/:engineSessionId/state-blobs',
    owner: 'ENG-06-SESSION-STATE-305',
    landed: true,
    mandate: {
      section: '20',
      because:
        'the write half of the same: a size-capped snapshot of an engine’s own state directory, which is what §14.9 asks the store to hold for an engine that keeps no entry list.',
    },
  },
];
