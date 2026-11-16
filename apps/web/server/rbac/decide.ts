/**
 * `decide` — "may this role do this to this route?", for every caller.
 *
 * The decision is `core/decide.ts`'s `decideRoute`, a pure core (AGENTS.md "Hexagonal rules" 2,
 * refactoring plan part 06). The one fact it needs from outside rbac is which of spec §34's
 * surfaces the path is on, and that question has one answer in the program: `classifyPath` from
 * `../auth/paths`. This shell asks it and passes the verdict in, so callers keep one function of
 * the query alone.
 */
import { classifyPath } from '../auth/paths';

import { decideRoute, type AuthorisationQuery, type Decision } from './core/decide';

export {
  ENDPOINT_SCOPE_KINDS,
  METHODS,
  OWNERSHIPS,
  TOKEN_SCOPE_KINDS,
  type AuthorisationQuery,
  type Decision,
  type Ownership,
  type TokenScope,
  type TokenScopeKind,
} from './core/decide';

/**
 * Decide one cell of the authorisation matrix. Never throws for a caller's benefit: a query it
 * cannot classify comes back as `refuse` with the reason (see `decideRoute`).
 */
export function decide(query: AuthorisationQuery): Decision {
  return decideRoute(query, classifyPath(query.path));
}
