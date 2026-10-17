import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { OPENAPI_DOCUMENT_MAX_BYTES } from '@indx-workspace/contracts/tool-connectors';
import type { AgentWorkspaceClient, ToolConnectorBody } from '@indx-workspace/sdk';
import { toolConnectorBody, type PlannedTool } from '@indx-workspace/sdk/project';

import { nonBlank } from '../config.js';
import type { CliIo } from '../io.js';
import { escapes, type LoadedTool } from './load.js';
import { localProblem, problemsFromError, type ProjectProblem } from './problems.js';

/** How long `aw` waits for an `https` spec, headers and body together. */
const TOOL_SPEC_FETCH_TIMEOUT_MS = 10_000;

/**
 * The credential `aw check` sends in place of an `openapi` tool's secret: C10 lets a value travel
 * only in a create or a rotation, and a dry run judges the document and never calls the API.
 */
const CHECK_PLACEHOLDER_CREDENTIAL = 'aw-check-placeholder';

const TOO_LARGE = 'larger than 1 MiB';

/** A document read for a tool, or why it could not be. */
export type ToolDocument =
  | { readonly ok: true; readonly document: string; readonly digest: string }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export interface ReadToolDocumentOptions {
  /** The project's directory, absolute. */
  readonly root: string;
  readonly io: CliIo;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number | undefined;
}

class Unreadable extends Error {}

/** The bytes as UTF-8 text; anything else is refused rather than replaced. */
function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Unreadable('not UTF-8 text');
  }
}

async function readProjectFile(spec: string, root: string): Promise<Uint8Array | null> {
  let real: string;
  try {
    real = await realpath(path.join(root, ...spec.split('/')));
  } catch {
    throw new Unreadable('no such file');
  }
  if (escapes(path.relative(await realpath(root), real))) {
    throw new Unreadable('the file is outside the project');
  }
  const handle = await open(real, 'r').catch(() => {
    throw new Unreadable('the file cannot be opened');
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Unreadable('not a file');
    // Refused before reading, so an enormous file is never buffered.
    if (stat.size > OPENAPI_DOCUMENT_MAX_BYTES) return null;
    const bytes = await handle.readFile();
    return bytes.byteLength > OPENAPI_DOCUMENT_MAX_BYTES ? null : bytes;
  } finally {
    await handle.close();
  }
}

/** The body, read chunk by chunk and abandoned at the cap; `null` when it is over the cap. */
async function cappedBody(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > OPENAPI_DOCUMENT_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function fetchDocument(
  spec: string,
  options: ReadToolDocumentOptions,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await options.io.fetch(spec, {
      signal: AbortSignal.any([options.signal, timeout]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Unreadable(`answered ${String(response.status)}`);
    }
    // A double may leave `url` empty; a real fetch always says where it ended.
    if (response.url !== '' && new URL(response.url).protocol !== 'https:') {
      await response.body?.cancel();
      throw new Unreadable('redirected to a URL that is not https');
    }
    return await cappedBody(response);
  } catch (error) {
    if (options.signal.aborted) throw error;
    if (timeout.aborted) throw new Unreadable(`timed out after ${String(timeoutMs)} ms`);
    if (error instanceof Unreadable) throw error;
    // The reason of a failed fetch is not printed: it is not ours to vouch for.
    throw new Unreadable('could not be fetched');
  }
}

/**
 * The OpenAPI document an `openapiTool()` names (C15): a project-relative path, whose real path
 * must stay inside the project, or an `https` URL, fetched with `io.fetch` within `timeoutMs`
 * (10 s by default) and refused when it answers other than 2xx or ends on a URL that is not
 * `https`. Either way it is at most 1 MiB — a larger file is refused before it is read, and a
 * larger answer is abandoned at the cap — and UTF-8 text. `digest` is `sha256:<hex>` over that
 * text, the digest the server keeps for the document it was sent.
 *
 * A reason names the spec and what went wrong, never a header or a credential.
 * ponytail: an https spec is re-fetched on every sync; upgrade: ETag/If-None-Match.
 */
export async function readToolDocument(
  spec: string,
  options: ReadToolDocumentOptions,
): Promise<ToolDocument> {
  const timeoutMs = options.timeoutMs ?? TOOL_SPEC_FETCH_TIMEOUT_MS;
  try {
    const bytes = spec.startsWith('https:')
      ? await fetchDocument(spec, options, timeoutMs)
      : await readProjectFile(spec, options.root);
    if (bytes === null)
      return { ok: false, code: 'connector_spec_invalid', detail: `spec: ${TOO_LARGE}` };
    const document = utf8(bytes);
    const digest = `sha256:${createHash('sha256').update(document, 'utf8').digest('hex')}`;
    return { ok: true, document, digest };
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return { ok: false, code: 'tool_spec_unreadable', detail: `${spec}: ${error.message}` };
  }
}

/** The tool with its document, or the problem that stopped it, against the tool's file. */
export async function plannedTool(
  tool: LoadedTool,
  options: ReadToolDocumentOptions,
): Promise<PlannedTool | ProjectProblem> {
  const { definition } = tool;
  if (definition.kind === 'postgres') return { definition };
  const read = await readToolDocument(definition.spec, options);
  if (!read.ok) return localProblem(tool.file, read.code, [read.detail]);
  return { definition, document: read.document, digest: read.digest };
}

/** Whether `value` is the problem {@link plannedTool} gives instead of a tool. */
export function isProblem(value: PlannedTool | ProjectProblem): value is ProjectProblem {
  return 'code' in value;
}

/**
 * A tool's connector body with its credential: an `openapi` body takes one only when its `auth` is
 * not `none`; a `postgres` body always needs its connection URL.
 */
export function withCredential(
  body: ReturnType<typeof toolConnectorBody>,
  credential: string | undefined,
): ToolConnectorBody {
  if (body.kind === 'openapi') return credential === undefined ? body : { ...body, credential };
  // The plan names a postgres tool's secret only when it is set; anything else is a bug.
  if (credential === undefined) throw new Error(`the "${body.name}" tool has no connection URL`);
  return { ...body, credential };
}

export interface CheckToolsOptions extends ReadToolDocumentOptions {
  readonly client: AgentWorkspaceClient;
}

/**
 * `aw check`'s tool step (C15): dry-run each tool's connector through the server's registration
 * — a `PATCH` dry run of the connector of that name when the workspace has one, else a `POST` —
 * and say every refusal against the tool's file. Nothing is saved.
 *
 * An `openapi` tool is sent with {@link CHECK_PLACEHOLDER_CREDENTIAL}, never its secret's value
 * (C10). A `postgres` tool's connection URL is its secret's value, because the host in it is what
 * the dry run judges; when the variable is unset the C10 notice is printed and the tool skipped.
 */
export async function checkTools(
  options: CheckToolsOptions,
  tools: readonly LoadedTool[],
): Promise<readonly ProjectProblem[]> {
  const { client, io, signal } = options;
  const problems: ProjectProblem[] = [];
  let existing;
  try {
    existing = await client.connectors.list({ signal });
  } catch (error) {
    for (const tool of tools) problems.push(...problemsFromError(error, tool.file, []));
    return problems;
  }
  for (const tool of tools) {
    const planned = await plannedTool(tool, options);
    if (isProblem(planned)) {
      problems.push(planned);
      continue;
    }
    const { definition } = tool;
    let credential: string | undefined;
    if (definition.kind === 'postgres') {
      credential = nonBlank(io.env[definition.credential.secret]);
      if (credential === undefined) {
        const name = definition.credential.secret;
        // The C10 notice `planProjectResources` gives `aw dev`.
        io.stderr(
          `notice: ${name} is not set: run export ${name}=… in the shell aw dev started from, then restart aw dev\n`,
        );
        continue;
      }
    } else if (definition.auth !== 'none') {
      credential = CHECK_PLACEHOLDER_CREDENTIAL;
    }
    const body = withCredential(toolConnectorBody(planned), credential);
    const connectorId = existing.find((connector) => connector.name === definition.name)?.id;
    try {
      await client.connectors.checkTool(body, { connectorId, signal });
    } catch (error) {
      problems.push(...problemsFromError(error, tool.file, []));
    }
  }
  return problems;
}
