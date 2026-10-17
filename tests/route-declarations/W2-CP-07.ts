/**
 * W2-CP-07 · durable session state · spec §20, §14.9.
 *
 * `GET /api/sessions` is printed verbatim in spec §34, so it carries no `mandate` — under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2, adding one would *fail* the gate.
 *
 * The four transcript routes are not printed in §34, so each cites §20 — the section that says
 * *"Implement a TypeScript `SessionStore` backed by durable storage"* and lists **Resume session**
 * among the operations the platform must support. §14.9 is the sentence that makes it a release
 * blocker rather than an improvement, but `## 14.9` is a second-level heading and the gate's
 * heading parser reads only `# N` sections, so the citation that can be *checked* is §20 and the
 * `because` line carries the §14.9 sentence.
 *
 * `POST /api/sessions/:id/messages` is printed in §34 and is **not** declared here: this task
 * ships no such route. It is the follow-up-turn endpoint the disabled composer under the run view
 * needs, and it belongs with whoever owns that screen.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  { method: 'GET', path: '/api/sessions', owner: 'W2-CP-07', landed: true },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId',
    owner: 'W2-CP-07',
    landed: true,
    mandate: {
      section: '20',
      because: 'session lifecycle management requires reading complete metadata for one session.',
    },
  },
  {
    method: 'PATCH',
    path: '/api/sessions/:engineSessionId',
    owner: 'W2-CP-07',
    landed: true,
    mandate: {
      section: '20',
      because:
        'archive, restore, and title changes are session lifecycle operations required by §20.',
    },
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/transcript',
    owner: 'W2-CP-07',
    landed: true,
    mandate: {
      section: '20',
      because:
        'the SessionStore’s load(): §14.9 requires the durable store to persist "the Agent SDK session state, not only the session id", and a resume reads it back through this route.',
    },
  },
  {
    method: 'POST',
    path: '/api/sessions/:engineSessionId/transcript',
    owner: 'W2-CP-07',
    landed: true,
    mandate: {
      section: '20',
      because:
        'the SessionStore’s append(): the SDK mirrors every transcript batch to this route, which is what moves session state out of the sandbox’s CLAUDE_CONFIG_DIR.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/sessions/:engineSessionId/transcript',
    owner: 'W2-CP-07',
    landed: true,
    mandate: {
      section: '20',
      because:
        'the SessionStore’s delete(): §20 lists "Archive session" among the operations the platform must support, and a store with no delete cannot honour it.',
    },
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/subkeys',
    owner: 'W2-CP-07',
    landed: true,
    mandate: {
      section: '20',
      because:
        'the SessionStore’s listSubkeys(): without it a resume restores the main transcript and loses every subagent transcript (R-01 §7).',
    },
  },
];
