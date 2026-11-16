/**
 * ENG-06 · the sub segments of `/api/sessions/:engineSessionId/state-*` — spec §20, §21, §14.9.
 *
 * The three segments this unit ships, declared for the reason `W2-CP-07.ts` beside this file
 * records: `decide()` refuses a sub segment nobody has classified, and `authorisation-matrix.test.ts`
 * counts every refused cell. The reading is the same one `permissions.ts` already applies to
 * `runs: ['events']` — *"they are the contents of the run, so reading them is reading the run"* —
 * carried over to a session's own state.
 *
 * What is deliberately NOT claimed: that a stream, a blob or an entry is a resource of its own.
 * Making one would mean writing four roles' grants over it, which is a reading of §21 and belongs
 * in `permissions.ts` with the rest of §21's table. Attaching them to the session is the narrower
 * claim, and it is the one §21's text supports.
 */
import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'ENG-06-SESSION-STATE-305',
    resource: 'sessions',
    sub: 'state-entries',
    because:
      '§21 Viewer — "view their own sessions" — and Builder — "share own agents, projects and sessions". A session\'s engine state is what §20 makes the durable store exist for and what §14.9 calls "the Agent SDK session state, not only the session id", generalised past one engine. Reading, appending to or clearing it is reading, writing or clearing the session.',
  },
  {
    owner: 'ENG-06-SESSION-STATE-305',
    resource: 'sessions',
    sub: 'state-streams',
    because:
      '§20 lists "Resume session" among the operations the platform must support, and a resume restores every stream the session has. A stream key names state of this same session, so listing them is reading the session; §21 gives no separate capability over them.',
  },
  {
    owner: 'ENG-06-SESSION-STATE-305',
    resource: 'sessions',
    sub: 'state-blobs',
    because:
      "the same reading as state-entries, for an engine whose state is a file snapshot rather than an entry list. A blob is the session's own conversation in another shape, not a file the tenant owns — §16's files are a separate resource with their own grants, and nothing here touches them.",
  },
];
