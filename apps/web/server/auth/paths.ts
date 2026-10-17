/**
 * The path-prefix rule — spec §34.
 *
 * §34 says why this file exists, in its own words: *"The public routes live under `/p/` rather
 * than `/api/` so that 'is this request authenticated?' is answerable by looking at the path
 * prefix alone."* This module is that sentence as code. It is deliberately **not** a list of
 * routes: a per-route allowlist is a list somebody has to remember to update, and the failure
 * mode when they forget is an unprotected endpoint. Here the failure mode when somebody adds a
 * route and forgets this file is a **401**, because everything under `/api/` is protected by
 * default and nothing under `/api/` can opt out.
 *
 * Three surfaces, and every request is exactly one of them:
 *
 *   * `api`    — `/api/**`. Requires a session. Wave 5's `/p/:token/messages` is deliberately
 *                *not* here; §34 puts it under `/p/`.
 *   * `public` — `/p/**`. The share surface of §20.6. Never authenticated, by construction.
 *   * `page`   — everything else: the browser shell.
 *
 * ## Why the two directions are not symmetric
 *
 * ADR-0015: a gate decides on a positive assertion, never on the absence of a negative. So the
 * two questions this file asks are asked with opposite biases, on purpose:
 *
 *   * **"Is this protected?"** is asked over every plausible reading of the path — the raw form,
 *     the percent-decoded form, the dot-segment-resolved form, each lower-cased. If *any* of them
 *     lands under `/api`, the answer is yes. Ambiguity protects.
 *   * **"Is this public?"** is asked over every plausible reading too, case-sensitively, and *all*
 *     of them must land under `/p`. Ambiguity does not release.
 *
 * A pathname that cannot be read at all — not a string, not absolute, undecodable — is classified
 * `api`, i.e. denied. Absence of a readable input is not absence of risk.
 */

/** The three surfaces of spec §34. Every path is exactly one. */
export type Surface = 'api' | 'public' | 'page';

/** What the gate does with a surface. */
export type Enforcement = 'deny-401' | 'allow';

export interface PathVerdict {
  readonly surface: Surface;
  /** Why this verdict, in words. Every branch below names itself; none falls through. */
  readonly reason: string;
}

/** The protected prefix. Not configurable: §34 fixes it, and a configurable gate is a gate. */
const API_PREFIX = '/api';

/** The public prefix. Likewise fixed by §34. */
const PUBLIC_PREFIX = '/p';

/**
 * Percent-decoding is applied repeatedly until it stops changing, so `%252e%252e` is read the
 * same way as `..`. No router decodes twice, so this can only ever *widen* the protected set —
 * which is the direction that is safe to be wrong in.
 */
const MAX_DECODE_ROUNDS = 4;

/** RFC 3986 §5.2.4, plus duplicate-slash collapse and trailing-slash removal. */
function removeDotSegments(pathname: string): string {
  const out: string[] = [];
  for (const segment of pathname.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join('/')}`;
}

/**
 * Every reading of the pathname a router, a proxy or a browser might plausibly arrive at.
 * Returns `null` when the input cannot be read as a pathname at all — the caller denies.
 */
function candidateForms(rawPathname: string): readonly string[] | null {
  const forms = new Set<string>();
  let current = rawPathname;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    // A backslash is not a path separator in a URL, but enough proxies and enough Windows
    // path-joining code treat it as one that reading it as a separator is the safe assumption.
    const separated = current.replace(/\\/gu, '/');
    forms.add(separated);
    forms.add(removeDotSegments(separated));
    let decoded: string;
    try {
      decoded = decodeURIComponent(separated);
    } catch {
      // Not decodable. Everything read so far still counts, but an undecodable pathname is
      // itself a reason to deny rather than to guess — say so by failing the whole read.
      return null;
    }
    if (decoded === separated) break;
    current = decoded;
  }
  return [...forms];
}

/** `prefix` itself, or anything below it. `/apiary` is not under `/api`. */
function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Classify a pathname. Total: every input returns a verdict, and the one branch that cannot
 * read its input denies rather than falling through to a pass.
 */
export function classifyPath(rawPathname: unknown): PathVerdict {
  if (typeof rawPathname !== 'string') {
    return { surface: 'api', reason: `pathname is ${typeof rawPathname}, not a string — denied` };
  }
  if (rawPathname.length === 0 || !rawPathname.startsWith('/')) {
    return { surface: 'api', reason: 'pathname is not an absolute path — denied' };
  }

  const forms = candidateForms(rawPathname);
  if (forms === null) {
    return { surface: 'api', reason: 'pathname contains an invalid percent-escape — denied' };
  }

  // Protected if ANY reading is under /api, matched case-insensitively so that a router or a
  // proxy that happens to be case-insensitive cannot open a hole this file did not see.
  const protectedForm = forms.find((form) => isUnder(form.toLowerCase(), API_PREFIX));
  if (protectedForm !== undefined) {
    return {
      surface: 'api',
      reason: `"${protectedForm}" is under ${API_PREFIX}/ — session required`,
    };
  }

  // Public only if EVERY reading is under /p, matched case-sensitively: `/P/x` is not `/p/x`,
  // and a path that is public under one reading and something else under another is not public.
  if (forms.every((form) => isUnder(form, PUBLIC_PREFIX))) {
    return {
      surface: 'public',
      reason: `every reading is under ${PUBLIC_PREFIX}/ — spec §34 public surface`,
    };
  }

  return { surface: 'page', reason: 'browser page surface — neither /api/ nor /p/' };
}

/**
 * What the gate does with each surface. Exhaustive, with an explicit `default` that throws
 * rather than returning `allow`: if a fourth surface is ever added, this fails loudly instead of
 * silently letting it through (ADR-0015).
 */
export function enforcementFor(surface: Surface): Enforcement {
  switch (surface) {
    case 'api':
      return 'deny-401';
    case 'public':
      return 'allow';
    case 'page':
      // Not a claim that pages need no session. It is a statement that **this** middleware does
      // not gate them: no Wave 1 task owns a sign-in page, so a redirect here would point at a
      // route that does not exist. Page-level enforcement is `requireSession()` in the server
      // component, and is declared unbuilt in W1-CP-06's PR. See
      // docs/adr/W1-CP-06-the-gate-covers-api-only.md.
      return 'allow';
    default: {
      const unreachable: never = surface;
      throw new Error(`unclassified surface ${JSON.stringify(unreachable)} — refusing to allow`);
    }
  }
}
