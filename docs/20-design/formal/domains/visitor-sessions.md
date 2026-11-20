# Visitor sessions

An embedded surface (issue #622) hands an anonymous visitor a session-scoped browser token from
`POST /p/s/<name>/sessions`, with no sign-in. The model is `formal/AgentWorkspace/Authz/VisitorSession.lean`;
the theorems are in `formal/AgentWorkspace/Theorems/Adversarial/AuthzRunToken.lean`, next to
`run_a_token_cannot_reach_run_b_connector`. Nothing here is about rate or turn limits.

## The visitor token

The token's scope names one session, and that session's row names its workspace and its surface, so
reaching only its session is reaching only its own workspace and surface. Two halves refuse a
request, both with `403 token_out_of_scope`:

1. `decide()`'s scope grammar (`checkTokenScope`, `apps/web/server/rbac/decide.ts`) admits only the
   route shapes of a session scope: `GET /api/runs/:id`, `GET /api/runs/:id/events`,
   `POST /api/agents/:id/runs`, `POST /api/runs/:id/feedback`, the presigned file download URL, and
   `POST /api/sessions/:id/attachments`, which only the scope's own session may reach (issue #1308).
2. `requireSessionScopeMatch` (`apps/web/server/runs/api.ts`) compares the session the run row, or
   the turn's body, names with the scope's. A turn whose body names no session is refused too.

`visitorDecision` composes the two; `proceed` means the route's own checks decide as usual.

| Tier | Theorem                                          | Meaning to a customer                                                                                |
| ---- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| T3   | `visitor_token_reaches_only_its_session`         | A visitor's token is refused on every run read, run events, turn and rating of any other session     |
| T3   | `visitor_token_proceeds_only_inside_its_grammar` | The token goes on only for its own session, and only to read a run by id, start a turn or rate a run |
| T3   | `visitor_token_has_allow_witness`                | The refusals are not vacuous: the same requests for its own session go on                            |

## Opening a session

`openVerdict` is `mayOpenSession` (`apps/web/server/surfaces/public/conditions.ts`), with ADR-0105's
loopback conditions folded into one input and the shared CSRF check's verdict as `sameOrigin`. The
token is minted only when it admits the request: `mintAfterOpen` models `createSurfaceSession`'s
open → mint step (`apps/web/server/surfaces/public/handlers.ts`).

| Tier | Theorem                                                  | Meaning to a customer                                                                       |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| T3   | `cross_origin_visitor_opens_only_from_an_allowed_origin` | A cross-origin page opens a session only when its `Origin` is one the surface lists exactly |
| T3   | `missing_origin_never_opens_a_session`                   | Off loopback, a cross-origin request with no `Origin` or `Origin: null` never opens one     |
| T3   | `visitor_token_minted_only_after_open_verdict`           | A visitor token is minted only when `mayOpenSession` admitted the request, for that session |
| T3   | `visitor_mint_has_witness`                               | The refusal is not vacuous: an admitted bootstrap mints its session's token                 |

## The pinned version

A visitor session opened on surface F, resolved to version V, stores V
(`sessions.agent_version_id = resolved.versionId`, `resolveSessionVersion`). It refines the
release model's pinned session ([release](release.md#the-release-model)).

| Tier | Theorem                                     | Meaning to a customer                                                                                                  |
| ---- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| T3   | `visitor_session_pins_the_resolved_version` | A visitor session is pinned to the version its environment pointed at; with `session_version_stable`, nothing moves it |

## Vectors

`formal/Vectors/AuthzRunToken.lean` emits `formal/generated/vectors/authz-run-token/visitor.json`
(seven routes, each for the token's own session, another session and none) and `open.json` (the
grid of loopback, same-origin, allowed list, `Origin` and mode). `apps/web/formal/authz-run-token.test.ts`
replays `visitor.json` against the real `decide()` and `requireSessionScopeMatch`, and `open.json`
against the real `mayOpenSession`.
