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
// makes "a PR can never write the trusted cache" an enforced property.
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

/**
 * Map verified claims to a cache role, or null (= no access at all).
 * @param {Record<string, unknown>} claims
 * @param {{ repository: string, repositoryId?: string, writeRefs: string[],
 *           writeEvents: string[], allowRead: boolean }} policy
 */
export function roleForClaims(claims, policy) {
  if (claims.repository !== policy.repository) return null;
  if (
    policy.repositoryId &&
    String(claims.repository_id) !== String(policy.repositoryId)
  )
    return null;
  if (
    policy.writeRefs.includes(claims.ref) &&
    policy.writeEvents.includes(claims.event_name)
  ) {
    return "write";
  }
  return policy.allowRead ? "read" : null;
}
