/**
 * What a run's code tools need from the runner (ADR-0118 TS2 to TS5): the `ToolSandboxRequest` for
 * the version's pinned bundles. Every bundle is read by digest, every declared secret is resolved
 * by name from the workspace, and the domains are the union the tools declared. A tool the sandbox
 * cannot serve, a bundle that is gone and a secret that is not set each fail the run by name; a
 * code tool is never dropped.
 */
import { createHash } from 'node:crypto';

import {
  ToolSandboxRequestSchema,
  type AgentVersionToolBundle,
  type ToolSandboxRequest,
} from '@indx-workspace/contracts/agent-versions';

import { DomainError } from '../errors';
import { isStorageConnectionSecretName } from '../secrets/contract';

/** Used when an entry pinned no `timeoutMs`; `aw push` always records one. */
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export interface ToolSandboxSources {
  /** The bytes stored for `digest`, or `null`. */
  readonly bundle: (digest: string) => Promise<Uint8Array | null>;
  /** The workspace secret `name`, or `null` when it is not set. */
  readonly secret: (name: string) => Promise<string | null>;
  /** The gateway signing secret, for the run's tool token. */
  readonly runToken: (runId: string) => Promise<string>;
}

function refuse(code: string, message: string): DomainError {
  return new DomainError({ category: 'validation', code, publicMessage: `${code}: ${message}` });
}

/** The tool sandbox request for `runId`; `bundles` is non-empty. */
export async function buildToolSandboxRequest(
  runId: string,
  bundles: readonly AgentVersionToolBundle[],
  sources: ToolSandboxSources,
): Promise<ToolSandboxRequest> {
  const tools = [];
  const domains = new Set<string>();
  const secretNames = new Set<string>();
  for (const bundle of bundles) {
    const { description, inputSchema } = bundle;
    if (description === undefined || inputSchema === undefined) {
      throw refuse(
        'code_tool_unbundled',
        `the code tool ${bundle.tool} pinned no description or input schema, so a tool sandbox cannot serve it; push it again with aw push.`,
      );
    }
    const bytes = await sources.bundle(bundle.digest);
    if (bytes === null) {
      throw refuse(
        'code_tool_bundle_missing',
        `the bundle of the code tool ${bundle.tool} (${bundle.digest}) is not stored in this workspace.`,
      );
    }
    tools.push({
      name: bundle.tool,
      description,
      inputSchema,
      timeoutMs: bundle.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      digest: bundle.digest,
      bundleBase64: Buffer.from(bytes).toString('base64'),
    });
    for (const name of bundle.secrets ?? []) secretNames.add(name);
    for (const domain of bundle.allowedDomains ?? []) domains.add(domain);
  }

  const env: Record<string, string> = {};
  for (const name of [...secretNames].toSorted()) {
    // A storage connection's credential is never a tool's, even for a version stored before the
    // contracts refused the name: it is not read, and the tool is refused as for a missing secret.
    const value = isStorageConnectionSecretName(name) ? null : await sources.secret(name);
    if (value === null) {
      throw refuse(
        'code_tool_secret_missing',
        `a code tool declares the secret ${name}, and this workspace has not set it.`,
      );
    }
    env[name] = value;
  }

  // ponytail: the key hashes the tools' declarations and the secret values, so a changed set or a
  // rotated secret replaces the session's sandbox; it does not tell which secret changed.
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        tools.map((tool) => [
          tool.name,
          tool.description,
          tool.inputSchema,
          tool.timeoutMs,
          tool.digest,
        ]),
        env,
        [...domains].toSorted(),
      ]),
    )
    .digest('hex');
  return ToolSandboxRequestSchema.parse({
    key,
    manifest: { tools, env },
    allowedDomains: [...domains].toSorted(),
    run: { runId, token: await sources.runToken(runId) },
  });
}
