/**
 * The HTTP edge of `POST /api/tool-bundles` and `GET /api/tool-bundles/:digest` (issue #790):
 * the bounded body reader and the workspace's object store, so each route file holds two calls.
 * Bundles share the skills object-store root, so a deployment without skills storage answers
 * `503 tool_bundles_not_configured` rather than an empty answer (ADR-0015).
 */
import {
  TOOL_BUNDLE_MAX_BYTES,
  TOOL_BUNDLE_PROBLEM_CODES,
} from '@indx-workspace/contracts/agent-versions';

import { problem, type ApiResult } from '../agents/handlers';
import { readBoundedJson } from '../http/json-transport';
import type { ObjectStore } from '../skills/object-store-bridge';
import { currentSkillsRuntime } from '../skills/runtime';
import { toolBundleLookup, type ToolBundleLookup } from './handlers';

/** Base64 of the largest bundle, plus room for the JSON envelope. */
const MAX_UPLOAD_BODY_BYTES = Math.ceil(TOOL_BUNDLE_MAX_BYTES / 3) * 4 + 1024;

export function toolBundlesNotConfigured(): ApiResult {
  return problem(
    TOOL_BUNDLE_PROBLEM_CODES.tool_bundles_not_configured,
    'tool_bundles_not_configured',
    'Tool bundles are not configured for this deployment.',
  );
}

/** The object store of `workspaceId`, or `null` when this deployment has no skills storage. */
export function openToolBundleStore(workspaceId: string): ObjectStore | null {
  return currentSkillsRuntime()?.store.forWorkspace(workspaceId) ?? null;
}

/** The version pipeline's lookup over `workspaceId`'s bundles, or `null` without storage. */
export function openToolBundleLookup(workspaceId: string): ToolBundleLookup | null {
  const store = openToolBundleStore(workspaceId);
  return store === null ? null : toolBundleLookup(store);
}

/** Read an upload body within the cap for a bundle of {@link TOOL_BUNDLE_MAX_BYTES} bytes. */
export async function readToolBundleBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  return readBoundedJson(request, { maxBytes: MAX_UPLOAD_BODY_BYTES, problem });
}
