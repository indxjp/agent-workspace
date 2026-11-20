#!/usr/bin/env node
// Entry point: configuration comes only from the environment (Cloud Run env
// vars + Secret Manager references, or a systemd EnvironmentFile on a VM).
//
//   PORT                         listen port (default 8080)
//   NX_CACHE_HTTP2               "1" → serve h2c (Cloud Run --use-http2); else HTTP/1.1
//   NX_CACHE_STORAGE             "gcs" | "fs" | "memory"
//   NX_CACHE_GCS_BUCKET          bucket name (gcs)
//   NX_CACHE_GCS_PREFIX          object prefix (default "nx/v1/")
//   NX_CACHE_GCS_ENDPOINT        override, e.g. a GCS emulator (default storage.googleapis.com)
//   NX_CACHE_GCS_ACCESS_TOKEN    static OAuth token (local testing only; Cloud Run uses the metadata server)
//   NX_CACHE_FS_ROOT             directory (fs)
//   NX_CACHE_READ_TOKENS         comma-separated static read tokens   (secret)
//   NX_CACHE_WRITE_TOKENS        comma-separated static write tokens  (secret, break-glass; CI writes via OIDC)
//   NX_CACHE_SIGNING_KEY         HMAC key for minted tokens; enables POST /v1/token (secret)
//   NX_CACHE_OIDC_AUDIENCE       expected `aud` (default "indx-nx-cache")
//   NX_CACHE_OIDC_REPOSITORY     e.g. "example-org/example-repo" — required for OIDC
//   NX_CACHE_OIDC_REPOSITORY_ID  numeric repo id (guards against rename/re-create squatting)
//   NX_CACHE_OIDC_WRITE_REFS     refs that may write; `*` = one path segment
//                                (default DEFAULT_WRITE_REFS below)
//   NX_CACHE_OIDC_WRITE_EVENTS   events that may write, from push, schedule,
//                                merge_group, pull_request (default DEFAULT_WRITE_EVENTS)
//   NX_CACHE_OIDC_WRITE_PR_BASE_REFS  base branches a writing pull_request must
//                                target (`base_ref` claim; default "main")
//   A write needs the event, a matching ref AND the ref shape GitHub gives that
//   event (oidc.mjs). deploy-gcp.sh sets the D1/D1b policy; rollback to the
//   main-only default (ADR-0110 Amendment 2026-11-19): WRITE_REFS=refs/heads/main,
//   WRITE_EVENTS=push,schedule.
//   NX_CACHE_OIDC_ALLOW_READ     "1" (default) → other refs of the repo get read tokens
//   NX_CACHE_TOKEN_TTL_SECONDS   minted token lifetime (default 10800 = 3 h)
//   NX_CACHE_MAX_BYTES           largest accepted artifact (default 2 GiB)
import { createAuth, parseTokenList } from './auth.mjs';
import { createLogger } from './log.mjs';
import { compilePolicy, jwksProvider } from './oidc.mjs';
import { createCacheHandler, createCacheServer, DEFAULT_MAX_BYTES } from './server.mjs';
import { fsStorage } from './storage/fs.mjs';
import { gcsStorage, gcsTokenProvider } from './storage/gcs.mjs';
import { memoryStorage } from './storage/memory.mjs';

// Fail-safe defaults: only main's push and nightly write. The wider policy of
// owner decisions D1 (merge queue) and D1b (same-repository pull requests),
// ADR-0110 Amendment 2026-11-19, is opted into by the one deployment it covers:
// deploy-gcp.sh sets both variables, after checking that forks get no OIDC
// token. A deployment that sets neither never grants a pull request write.
// 409 no-overwrite (first writer wins) is unchanged for all of them.
export const DEFAULT_WRITE_REFS = 'refs/heads/main';
export const DEFAULT_WRITE_EVENTS = 'push,schedule';

export function buildFromEnv(env = process.env) {
  const log = createLogger();
  const kind = env.NX_CACHE_STORAGE ?? 'gcs';
  let storage;
  if (kind === 'gcs') {
    storage = gcsStorage({
      bucket: env.NX_CACHE_GCS_BUCKET,
      prefix: env.NX_CACHE_GCS_PREFIX ?? 'nx/v1/',
      endpoint: env.NX_CACHE_GCS_ENDPOINT ?? 'https://storage.googleapis.com',
      getToken: gcsTokenProvider({
        staticToken: env.NX_CACHE_GCS_ACCESS_TOKEN,
      }),
    });
  } else if (kind === 'fs') {
    if (!env.NX_CACHE_FS_ROOT)
      throw new Error('NX_CACHE_FS_ROOT is required for NX_CACHE_STORAGE=fs');
    storage = fsStorage({ root: env.NX_CACHE_FS_ROOT });
  } else if (kind === 'memory') {
    storage = memoryStorage();
  } else {
    throw new Error(`unknown NX_CACHE_STORAGE "${kind}"`);
  }

  const auth = createAuth({
    readTokens: parseTokenList(env.NX_CACHE_READ_TOKENS),
    writeTokens: parseTokenList(env.NX_CACHE_WRITE_TOKENS),
    signingKey: env.NX_CACHE_SIGNING_KEY || undefined,
  });

  let oidc;
  if (env.NX_CACHE_OIDC_REPOSITORY && auth.canMint) {
    oidc = {
      audience: env.NX_CACHE_OIDC_AUDIENCE ?? 'indx-nx-cache',
      getKey: jwksProvider({ url: env.NX_CACHE_OIDC_JWKS_URL || undefined }),
      ttlSeconds: Number(env.NX_CACHE_TOKEN_TTL_SECONDS ?? 10_800),
      policy: compilePolicy({
        repository: env.NX_CACHE_OIDC_REPOSITORY,
        repositoryId: env.NX_CACHE_OIDC_REPOSITORY_ID || undefined,
        writeRefs: parseTokenList(env.NX_CACHE_OIDC_WRITE_REFS ?? DEFAULT_WRITE_REFS),
        writeEvents: parseTokenList(env.NX_CACHE_OIDC_WRITE_EVENTS ?? DEFAULT_WRITE_EVENTS),
        pullRequestBaseRefs: parseTokenList(env.NX_CACHE_OIDC_WRITE_PR_BASE_REFS ?? 'main'),
        allowRead: (env.NX_CACHE_OIDC_ALLOW_READ ?? '1') === '1',
      }),
    };
  }

  const handler = createCacheHandler({
    storage,
    auth,
    log,
    maxBytes: Number(env.NX_CACHE_MAX_BYTES ?? DEFAULT_MAX_BYTES),
    oidc,
  });
  const server = createCacheServer(handler, {
    http2: env.NX_CACHE_HTTP2 === '1',
  });
  return { server, log, storage, oidc };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('main.mjs')) {
  const { server, log, storage, oidc } = buildFromEnv();
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () =>
    log.info('listening', {
      port,
      storage: storage.kind,
      http2: process.env.NX_CACHE_HTTP2 === '1',
      oidc: Boolean(oidc),
    }),
  );
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
