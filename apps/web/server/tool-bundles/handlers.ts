/**
 * The tool-bundle operations (ADR-0118 TS1; issue #790), as functions of the workspace's object
 * store and an already-parsed body. A bundle is the one ESM file `aw push` built from a code tool's
 * run file. It is addressed by the SHA-256 of its bytes, so an upload is idempotent: the same bytes
 * are stored once, and a digest names exactly one program.
 *
 * Bundles live in the workspace's skills object store under `tool-bundles/<digest>.mjs`, a prefix
 * the skills API never reads (it lists `skills/` and `skill-meta/`).
 */
import { createHash } from 'node:crypto';

import {
  TOOL_BUNDLE_DIGEST_PATTERN,
  TOOL_BUNDLE_MAX_BYTES,
  TOOL_BUNDLE_PROBLEM_CODES,
  UploadToolBundleRequestSchema,
  type ToolBundle,
  type UploadToolBundleResponse,
} from '@indx-workspace/contracts/agent-versions';

import { problem, type ApiResult } from '../agents/handlers';
import type { ObjectStore } from '../skills/object-store-bridge';

/** The key of the bundle with `digest`, which the caller has already matched against the pattern. */
function bundleKey(digest: string): string {
  return `tool-bundles/${digest}.mjs`;
}

/** The digests among `digests` this workspace has no bundle for, in the order given. */
export type ToolBundleLookup = (digests: readonly string[]) => Promise<readonly string[]>;

/** A {@link ToolBundleLookup} over `store`. */
export function toolBundleLookup(store: ObjectStore): ToolBundleLookup {
  // One prefix listing per digest asked about, so the cost is bounded by the agent's tool count,
  // not by how many bundles the workspace holds.
  return async (digests) => {
    const missing: string[] = [];
    for (const digest of digests) {
      if ((await store.listPrefix(bundleKey(digest))).length === 0) missing.push(digest);
    }
    return missing;
  };
}

/** The bytes of the bundle with `digest`, or `null` when this workspace holds none that match it. */
export async function readToolBundle(
  store: ObjectStore,
  digest: string,
): Promise<Uint8Array | null> {
  const found = await store.get(bundleKey(digest));
  if (found === null) return null;
  // A digest names exactly one program, so bytes that do not hash to it are not the bundle.
  return createHash('sha256').update(found.body).digest('hex') === digest ? found.body : null;
}

/** Store the bytes in `contentBase64` under their digest; `created` is false when already stored. */
export async function uploadToolBundle(store: ObjectStore, raw: unknown): Promise<ApiResult> {
  const parsed = UploadToolBundleRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return problem(
      TOOL_BUNDLE_PROBLEM_CODES.invalid_tool_bundle,
      'invalid_tool_bundle',
      'The body is not a tool bundle upload.',
      parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }
  const bytes = Buffer.from(parsed.data.contentBase64, 'base64');
  if (bytes.byteLength > TOOL_BUNDLE_MAX_BYTES) {
    return problem(
      TOOL_BUNDLE_PROBLEM_CODES.tool_bundle_too_large,
      'tool_bundle_too_large',
      `A tool bundle is at most ${String(TOOL_BUNDLE_MAX_BYTES)} bytes.`,
    );
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  const created = (await toolBundleLookup(store)([digest])).length > 0;
  if (created) {
    await store.put(bundleKey(digest), {
      body: new Uint8Array(bytes),
      contentType: 'text/javascript',
    });
  }
  const bundle: ToolBundle = { digest, sizeBytes: bytes.byteLength };
  return {
    status: created ? 201 : 200,
    body: { bundle, created } satisfies UploadToolBundleResponse,
  };
}

/** The bundle with `digest`, or `404 tool_bundle_not_found` (also for a digest that is no SHA-256). */
export async function getToolBundle(store: ObjectStore, digest: unknown): Promise<ApiResult> {
  const found =
    typeof digest === 'string' && TOOL_BUNDLE_DIGEST_PATTERN.test(digest)
      ? (await store.listPrefix(bundleKey(digest))).find((entry) => entry.kind === 'file')
      : undefined;
  if (found?.kind !== 'file' || typeof digest !== 'string') {
    return problem(
      TOOL_BUNDLE_PROBLEM_CODES.tool_bundle_not_found,
      'tool_bundle_not_found',
      'This workspace has no tool bundle with that digest.',
    );
  }
  const bundle: ToolBundle = { digest, sizeBytes: found.sizeBytes };
  return { status: 200, body: { bundle } };
}
