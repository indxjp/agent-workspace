// Bearer-token authentication. Two token families resolve to a role
// ("read" | "write"):
//
//   1. Static tokens from configuration (NX_CACHE_READ_TOKENS /
//      NX_CACHE_WRITE_TOKENS, comma-separated so a rotation can run old and
//      new side by side). Compared in constant time on their SHA-256 digests.
//   2. Short-lived tokens this server minted itself after verifying a GitHub
//      Actions OIDC token (see oidc.mjs / POST /v1/token). Format:
//      `nxc1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`, payload
//      `{ r: role, exp: epochSeconds, sub: string }`.
//
// The role is ALWAYS derived server-side from which token was presented —
// a client cannot ask for "write"; it can only hold a credential the server
// maps to write.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest();
const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Parse "a, b,,c" into ["a","b","c"]; empty/whitespace entries dropped. */
export function parseTokenList(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function bearer(header) {
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * @param {{ readTokens?: string[], writeTokens?: string[], signingKey?: string,
 *           now?: () => number }} opts
 */
export function createAuth({
  readTokens = [],
  writeTokens = [],
  signingKey,
  now = () => Date.now(),
}) {
  const MIN_LEN = 32;
  for (const t of [...readTokens, ...writeTokens]) {
    if (t.length < MIN_LEN)
      throw new Error(
        `static cache tokens must be at least ${MIN_LEN} characters`,
      );
  }
  if (signingKey !== undefined && signingKey.length < MIN_LEN) {
    throw new Error(
      `NX_CACHE_SIGNING_KEY must be at least ${MIN_LEN} characters`,
    );
  }
  const statics = [
    ...writeTokens.map((t) => ({ digest: sha256(t), role: "write" })),
    ...readTokens.map((t) => ({ digest: sha256(t), role: "read" })),
  ];
  const sign = (payloadB64) =>
    createHmac("sha256", signingKey).update(`nxc1.${payloadB64}`).digest();

  function verifyMinted(token) {
    if (!signingKey || !token.startsWith("nxc1.")) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [, payloadB64, sigB64] = parts;
    const expected = sign(payloadB64);
    const given = Buffer.from(sigB64, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return null;
    let payload;
    try {
      payload = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8"),
      );
    } catch {
      return null;
    }
    if (payload.r !== "read" && payload.r !== "write") return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now())
      return null;
    return { role: payload.r, principal: `oidc:${payload.sub}` };
  }

  return {
    /** @returns {{ role: "read"|"write", principal: string } | null} */
    authenticate(authorizationHeader) {
      const token = bearer(authorizationHeader);
      if (!token) return null;
      const minted = verifyMinted(token);
      if (minted) return minted;
      const digest = sha256(token);
      // Scan every entry (no early exit) so timing does not reveal which
      // list — or which position — matched.
      let match = null;
      for (const s of statics) {
        if (timingSafeEqual(digest, s.digest) && match === null) match = s;
      }
      // Static-token principals are identified by a digest prefix, never by
      // any part of the token itself, so logs can tell rotations apart
      // without leaking the secret.
      return match
        ? {
            role: match.role,
            principal: `static:${match.digest.toString("hex").slice(0, 8)}`,
          }
        : null;
    },
    canMint: Boolean(signingKey),
    /** Mint a short-lived token for a verified OIDC subject. */
    mint({ role, sub, ttlSeconds }) {
      if (!signingKey)
        throw new Error("minting disabled: no signing key configured");
      const exp = Math.floor(now() / 1000) + ttlSeconds;
      const payloadB64 = b64url(JSON.stringify({ r: role, exp, sub }));
      return { token: `nxc1.${payloadB64}.${b64url(sign(payloadB64))}`, exp };
    },
  };
}
