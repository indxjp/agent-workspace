import type { NextConfig } from 'next';

const NEXT_DIST_DIR_ENV = 'AW_NEXT_DIST_DIR';

/** One path segment that starts with `.next`: `.next`, `.next-runtime`, `.next.local`, ... */
const NEXT_DIST_DIR_PATTERN = /^\.next[\w.-]*$/u;

/**
 * The Next.js build output directory, from `AW_NEXT_DIST_DIR` (contract C2). Unset or blank gives
 * `.next`. Otherwise the value must be a single segment starting with `.next`. `next build` deletes
 * its distDir recursively before it builds, so a value such as `.`, `app`, `server` or `public/`
 * would delete this app's own sources; only a name reserved for build output is accepted.
 */
export function readNextDistDir(env: Readonly<Record<string, string | undefined>>): string {
  const raw = (env[NEXT_DIST_DIR_ENV] ?? '').trim();
  if (raw.length === 0) return '.next';
  if (!NEXT_DIST_DIR_PATTERN.test(raw)) {
    throw new Error(`${NEXT_DIST_DIR_ENV} must be a single directory name starting with '.next'`);
  }
  return raw;
}

const nextConfig: NextConfig = {
  // `next build` and the server that serves the build must see the same AW_NEXT_DIST_DIR, or the
  // server looks for a build in a directory the build never wrote. On Vercel Functions (ADR-0120
  // LC7) leave it unset: the platform's Next.js builder reads the default `.next`, and no setting
  // here is needed for the build itself. A run's stream consumer is kept alive by `after()` in
  // `server/composition/register.ts`, not by this file.
  distDir: readNextDistDir(process.env),
  // The Azure SDKs `@agent-workspace/core`'s blob store and key vault provider import stay
  // `node_modules` packages loaded at run time, as Next.js already does by default for
  // `@aws-sdk/client-s3` and `pg`. Bundled, their sources (including the public Azurite
  // development key in `@azure/storage-blob`) land in `.next/server` chunks and source maps.
  serverExternalPackages: ['@azure/identity', '@azure/keyvault-secrets', '@azure/storage-blob'],
};

export default nextConfig;
