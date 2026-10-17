// OIDC exchange: the server — not the workflow — decides read vs write from
// GitHub-signed claims. Tokens here are real RS256 JWTs signed with a local
// key pair; verification runs the production code path.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createAuth } from "../src/auth.mjs";
import { GITHUB_ISSUER, roleForClaims } from "../src/oidc.mjs";
import { memoryStorage } from "../src/storage/memory.mjs";
import { get, put, SIGNING_KEY, startCache } from "./helpers.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const KID = "test-kid";
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: KID,
  alg: "RS256",
  use: "sig",
};
const { privateKey: otherKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const POLICY = {
  repository: "example-org/example-repo",
  repositoryId: "1001",
  writeRefs: ["refs/heads/main"],
  writeEvents: ["push", "schedule"],
  allowRead: true,
};

function jwt(claims, { key = privateKey, kid = KID, alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg, kid, typ: "JWT" })).toString(
    "base64url",
  );
  const p = Buffer.from(
    JSON.stringify({
      iss: GITHUB_ISSUER,
      aud: "indx-nx-cache",
      iat: now,
      nbf: now - 5,
      exp: now + 300,
      repository: "example-org/example-repo",
      repository_id: "1001",
      run_id: "42",
      ...claims,
    }),
  ).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString(
    "base64url",
  );
  return `${h}.${p}.${s}`;
}

const mainPush = { ref: "refs/heads/main", event_name: "push" };
const nightly = { ref: "refs/heads/main", event_name: "schedule" };
const prRun = { ref: "refs/pull/7/merge", event_name: "pull_request" };

describe("roleForClaims", () => {
  test("main push / nightly → write; PR → read; foreign repo → none", () => {
    assert.equal(
      roleForClaims(
        { repository: "example-org/example-repo", repository_id: 1001, ...mainPush },
        POLICY,
      ),
      "write",
    );
    assert.equal(
      roleForClaims(
        { repository: "example-org/example-repo", repository_id: 1001, ...nightly },
        POLICY,
      ),
      "write",
    );
    assert.equal(
      roleForClaims(
        { repository: "example-org/example-repo", repository_id: 1001, ...prRun },
        POLICY,
      ),
      "read",
    );
    // pull_request_target / workflow_dispatch on main are not in writeEvents.
    assert.equal(
      roleForClaims(
        {
          repository: "example-org/example-repo",
          repository_id: 1001,
          ref: "refs/heads/main",
          event_name: "pull_request_target",
        },
        POLICY,
      ),
      "read",
    );
    // A PR whose head branch is literally named "main" still has a refs/pull/* ref.
    assert.equal(
      roleForClaims(
        {
          repository: "example-org/example-repo",
          repository_id: 1001,
          ref: "refs/heads/main-x",
          event_name: "push",
        },
        POLICY,
      ),
      "read",
    );
    assert.equal(
      roleForClaims(
        { repository: "evil/example-repo", repository_id: 1001, ...mainPush },
        POLICY,
      ),
      null,
    );
    assert.equal(
      roleForClaims(
        { repository: "example-org/example-repo", repository_id: 999, ...mainPush },
        POLICY,
      ),
      null,
    );
    assert.equal(
      roleForClaims(
        { repository: "example-org/example-repo", repository_id: 1001, ...prRun },
        { ...POLICY, allowRead: false },
      ),
      null,
    );
  });
});

describe("POST /v1/token", () => {
  let cache;
  before(async () => {
    cache = await startCache({
      storage: memoryStorage(),
      auth: createAuth({
        readTokens: [],
        writeTokens: [],
        signingKey: SIGNING_KEY,
      }),
      oidc: {
        audience: "indx-nx-cache",
        getKey: async (kid) => (kid === KID ? jwk : null),
        policy: POLICY,
        ttlSeconds: 600,
      },
    });
  });
  after(() => cache.close());

  const exchange = (token) =>
    fetch(`${cache.url}/v1/token`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  test("main push gets a write token that can PUT", async () => {
    const res = await exchange(jwt(mainPush));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.role, "write");
    assert.equal(
      (await put(cache.url, "oidc1", Buffer.from("trusted"), body.token))
        .status,
      200,
    );
    assert.equal((await get(cache.url, "oidc1", body.token)).status, 200);
  });

  test("a pull_request run gets a READ token — it cannot write even if its YAML asks for write", async () => {
    const res = await exchange(jwt(prRun));
    const body = await res.json();
    assert.equal(body.role, "read");
    assert.equal(
      (await put(cache.url, "oidc2", Buffer.from("poison"), body.token)).status,
      403,
    );
    assert.equal((await get(cache.url, "oidc1", body.token)).status, 200);
  });

  test("forged / expired / wrong-audience / wrong-issuer / alg-none JWTs are rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      jwt(mainPush, { key: otherKey }),
      jwt({ ...mainPush, exp: now - 3600 }),
      jwt({ ...mainPush, aud: "someone-else" }),
      jwt({ ...mainPush, iss: "https://evil.example" }),
      jwt(mainPush, { kid: "unknown" }),
      `${Buffer.from(JSON.stringify({ alg: "none", kid: KID })).toString("base64url")}.${jwt(mainPush).split(".")[1]}.`,
      "not-a-jwt",
    ];
    for (const t of bad)
      assert.equal((await exchange(t)).status, 401, t.slice(0, 30));
    assert.equal((await exchange(null)).status, 401);
    assert.equal(
      (await exchange(jwt({ ...mainPush, repository: "evil/x" }))).status,
      403,
    );
  });

  test("a minted token cannot be tampered into write", async () => {
    const { token } = await (await exchange(jwt(prRun))).json();
    const [prefix, payload, sig] = token.split(".");
    const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
    forged.r = "write";
    const tampered = `${prefix}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
    assert.equal(
      (await put(cache.url, "oidc3", Buffer.from("x"), tampered)).status,
      401,
    );
  });

  test("minted tokens expire", async () => {
    const auth = createAuth({ signingKey: SIGNING_KEY, now: () => 0 });
    const { token } = auth.mint({ role: "write", sub: "t", ttlSeconds: 60 });
    const later = createAuth({ signingKey: SIGNING_KEY, now: () => 61_000 });
    assert.equal(later.authenticate(`Bearer ${token}`), null);
    assert.equal(auth.authenticate(`Bearer ${token}`).role, "write");
  });

  test("JWTs never reach the log", async () => {
    const t = jwt(prRun);
    await exchange(t);
    assert.equal(cache.logs.join("\n").includes(t.split(".")[2]), false);
  });
});

describe("static token config", () => {
  test("short tokens / signing keys are refused at startup", () => {
    assert.throws(() => createAuth({ readTokens: ["short"] }));
    assert.throws(() => createAuth({ signingKey: "short" }));
  });
  test("rotation: old and new tokens both work while listed", () => {
    const a = createAuth({
      readTokens: ["a".repeat(32), "b".repeat(32)],
      writeTokens: ["c".repeat(32)],
    });
    assert.equal(a.authenticate(`Bearer ${"a".repeat(32)}`).role, "read");
    assert.equal(a.authenticate(`Bearer ${"b".repeat(32)}`).role, "read");
    assert.equal(a.authenticate(`Bearer ${"c".repeat(32)}`).role, "write");
    assert.equal(a.authenticate(`Bearer ${"d".repeat(32)}`), null);
  });
});
