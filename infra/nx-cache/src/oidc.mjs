// GitHub Actions OIDC verification + the read/write trust policy.
//
// Why OIDC for writes instead of a long-lived WRITE secret in GitHub: any
// collaborator who can open a same-repository pull request can edit the
// workflow YAML in that PR, and a `pull_request` run of the edited workflow
// can read every repository secret. A workflow-side "PRs get the read token"
// rule is therefore advisory against an insider-controlled PR. An OIDC token,
// by contrast, is signed by GitHub and its `ref` / `event_name` claims
// describe what ACTUALLY triggered the job — a PR run gets
// `ref=refs/pull/<n>/merge`, `event_name=pull_request`, whatever its YAML
// says. Deciding the role from those claims, here on the server, is what
// makes the write policy an enforced property rather than a workflow
// convention. Since ADR-0110's Amendment 2026-11-19 (owner decisions D1/D1b)
// that policy lets merge-queue groups and same-repository pull requests write
// too; it still never lets a workflow choose its own role.
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const DEFAULT_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
const CLOCK_SKEW_S = 60;

export class OidcError extends Error {
  constructor(message) {
    super(message);
    this.name = "OidcError";
  }
}

/** JWKS cache: refreshed hourly, and at most once a minute on an unknown kid. */
export function jwksProvider({
  url = DEFAULT_JWKS_URL,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  let keys = new Map();
  let fetchedAt = 0;
  async function refresh() {
    const res = await fetchImpl(url);
    if (!res.ok) throw new OidcError(`JWKS fetch failed: ${res.status}`);
    const body = await res.json();
    keys = new Map(
      (body.keys ?? []).filter((k) => k.kid).map((k) => [k.kid, k]),
    );
    fetchedAt = now();
  }
  return async (kid) => {
    if (now() - fetchedAt > 3_600_000) await refresh();
    if (!keys.has(kid) && now() - fetchedAt > 60_000) await refresh();
    return keys.get(kid) ?? null;
  };
}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new OidcError("malformed JWT");
  }
}

/**
 * Verify an RS256 JWT issued by GitHub Actions. Returns its claims.
 * @param {string} jwt
 * @param {{ audience: string, getKey: (kid: string) => Promise<object|null>,
 *           issuer?: string, now?: () => number }} opts
 */
export async function verifyGithubJwt(
  jwt,
  { audience, getKey, issuer = GITHUB_ISSUER, now = () => Date.now() },
) {
  const parts = String(jwt).split(".");
  if (parts.length !== 3) throw new OidcError("malformed JWT");
  const [h, p, s] = parts;
  const header = decodePart(h);
  if (header.alg !== "RS256")
    throw new OidcError(`unsupported alg ${header.alg}`);
  const jwk = await getKey(header.kid);
  if (!jwk) throw new OidcError("unknown signing key");
  const ok = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${h}.${p}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(s, "base64url"),
  );
  if (!ok) throw new OidcError("bad signature");
  const claims = decodePart(p);
  const t = Math.floor(now() / 1000);
  if (claims.iss !== issuer) throw new OidcError("wrong issuer");
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(audience)) throw new OidcError("wrong audience");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < t)
    throw new OidcError("token expired");
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > t)
    throw new OidcError("token not yet valid");
  return claims;
}

// The ref GitHub itself puts in the token for each event that may ever write
// (docs/adr/0110, Amendment 2026-11-19). A write needs the event in
// `writeEvents`, the ref in `writeRefs` AND the ref to have its event's shape,
// so the two lists cannot combine into a pair GitHub never issues: a `push` to
// a branch named `gh-readonly-queue/...` is not a queue group, and a
// `pull_request` token never carries `refs/heads/main`.
const REF_SHAPE_BY_EVENT = {
  push: /^refs\/heads\/(?!gh-readonly-queue\/)[^\s]+$/,
  schedule: /^refs\/heads\/(?!gh-readonly-queue\/)[^\s]+$/,
  merge_group: /^refs\/heads\/gh-readonly-queue\/[^\s]+$/,
  pull_request: /^refs\/pull\/[0-9]+\/merge$/,
};

/** The events a write policy may name; anything else is a configuration error. */
export const WRITE_CAPABLE_EVENTS = Object.freeze(
  Object.keys(REF_SHAPE_BY_EVENT),
);

/**
 * A `writeRefs` entry: an exact ref, or a pattern where each `*` stands for
 * one or more characters other than `/` (so `refs/pull/*\/merge` matches
 * `refs/pull/12/merge` and never `refs/pull/12/head/merge`).
 * @param {string} pattern
 */
export function refPattern(pattern) {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${source}$`);
}

/**
 * Validate and compile a write policy once, at startup. Throws on an event no
 * write rule can be checked for, so a typo fails the deploy instead of silently
 * granting or refusing.
 * @param {{ repository: string, repositoryId?: string, writeRefs: string[],
 *           writeEvents: string[], pullRequestBaseRefs?: string[],
 *           allowRead: boolean }} policy
 */
export function compilePolicy(policy) {
  for (const event of policy.writeEvents) {
    if (!WRITE_CAPABLE_EVENTS.includes(event)) {
      throw new Error(
        `NX_CACHE_OIDC_WRITE_EVENTS: "${event}" cannot be granted write (allowed: ${WRITE_CAPABLE_EVENTS.join(", ")})`,
      );
    }
  }
  if (
    policy.writeEvents.includes("pull_request") &&
    (policy.pullRequestBaseRefs ?? []).length === 0
  ) {
    throw new Error(
      "NX_CACHE_OIDC_WRITE_PR_BASE_REFS must name at least one base branch when pull_request may write",
    );
  }
  return {
    ...policy,
    pullRequestBaseRefs: policy.pullRequestBaseRefs ?? [],
    writeRefMatchers: policy.writeRefs.map(refPattern),
  };
}

/**
 * Map verified claims to a cache role, or null (= no access at all).
 *
 * Which claims decide (docs/40-operate/operations/ci.md "Who may read and who may write"):
 * - `repository` + `repository_id` must be this instance's repository. They
 *   name the repository the workflow RUNS in — the base repository, for every
 *   pull_request run.
 * - `event_name` must be in `writeEvents`, `ref` must match `writeRefs` and
 *   have that event's shape (REF_SHAPE_BY_EVENT).
 * - a `pull_request` run must also target one of `pullRequestBaseRefs`
 *   (`base_ref`, the PR's base branch).
 *
 * GitHub's token has NO claim naming a pull request's HEAD repository, so a
 * fork's pull_request run, which also runs in the base repository, would carry
 * the same claims. Forks are excluded because GitHub issues them no OIDC token
 * (public repositories never; private and internal ones only when the
 * "Send write tokens to workflows from fork pull requests" setting is on,
 * which must stay off — ADR-0110, Amendment 2026-11-19).
 * @param {Record<string, unknown>} claims
 * @param {{ repository: string, repositoryId?: string, writeRefs: string[],
 *           writeEvents: string[], pullRequestBaseRefs?: string[],
 *           allowRead: boolean, writeRefMatchers?: RegExp[] }} policy
 */
export function roleForClaims(claims, policy) {
  if (claims.repository !== policy.repository) return null;
  if (
    policy.repositoryId &&
    String(claims.repository_id) !== String(policy.repositoryId)
  )
    return null;
  return mayWrite(claims, policy)
    ? "write"
    : policy.allowRead
      ? "read"
      : null;
}

/** @param {Record<string, unknown>} claims @param {Parameters<typeof roleForClaims>[1]} policy */
function mayWrite(claims, policy) {
  const event = String(claims.event_name ?? "");
  const ref = String(claims.ref ?? "");
  if (!policy.writeEvents.includes(event)) return false;
  const shape = REF_SHAPE_BY_EVENT[event];
  if (!shape || !shape.test(ref)) return false;
  const matchers = policy.writeRefMatchers ?? policy.writeRefs.map(refPattern);
  if (!matchers.some((m) => m.test(ref))) return false;
  if (event === "pull_request") {
    return (policy.pullRequestBaseRefs ?? []).includes(
      String(claims.base_ref ?? ""),
    );
  }
  return true;
}
