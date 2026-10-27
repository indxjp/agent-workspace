/**
 * The domain of `POST /api/agents/:id/platform-exports` (issue #968): validate the request, build
 * the project for one stored version, compile it for the chosen platform, and shape the answer. No
 * HTTP and no authorisation here; `http.ts` owns both, so this runs against in-memory stores.
 */
import {
  PLATFORM_EXPORT_MAX_BYTES,
  PLATFORM_EXPORT_PROBLEM_CODES,
  PlatformExportRequestSchema,
  PlatformExportResponseSchema,
  type PlatformExportFile,
  type PlatformExportResponse,
} from '@indx-workspace/contracts/platforms';
import {
  compileForPlatform,
  formatPlatformReport,
  platformTarget,
} from '@indx-workspace/platforms';

import { problem, type ApiResult } from '../http/result';
import {
  buildPortableProject,
  PlatformExportTooLargeError,
  type PortableProjectSources,
} from './project';

const REPORT_FILE = 'PLATFORM_REPORT.md';

/** `<path>: <message>` lines for a refused body; `(body)` names an issue at the root. */
function issueLines(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): string[] {
  return error.issues.map(
    (issue) => `${issue.path.map(String).join('.') || '(body)'}: ${issue.message}`,
  );
}

function wireFile(path: string, content: string | Uint8Array): PlatformExportFile {
  return typeof content === 'string'
    ? { path, encoding: 'utf8', content }
    : { path, encoding: 'base64', content: Buffer.from(content).toString('base64') };
}

function decodedBytes(file: PlatformExportFile): number {
  return file.encoding === 'utf8'
    ? Buffer.byteLength(file.content, 'utf8')
    : Buffer.from(file.content, 'base64').byteLength;
}

function tooLarge(bytes: number): PlatformExportOutcome {
  return {
    ok: false,
    result: problem(
      PLATFORM_EXPORT_PROBLEM_CODES.platform_export_too_large,
      'platform_export_too_large',
      'The export is larger than this deployment serves; export a smaller agent or fewer skills.',
      [`bytes:${bytes}`, `max:${PLATFORM_EXPORT_MAX_BYTES}`],
    ),
  };
}

export type PlatformExportOutcome =
  | { readonly ok: true; readonly agentName: string; readonly response: PlatformExportResponse }
  | { readonly ok: false; readonly result: ApiResult };

/** The wire bytes of one exported file. */
export function exportFileBytes(file: PlatformExportFile): Uint8Array {
  return file.encoding === 'utf8'
    ? Buffer.from(file.content, 'utf8')
    : Buffer.from(file.content, 'base64');
}

/**
 * Export version `body.version` of `agentId` for `body.platform`. `body` is the parsed-but-unchecked
 * request. Every expected failure is an `ok: false` result; a response that no longer matches its
 * own schema throws, which the route answers as a 500 rather than serving a drifted shape.
 */
export async function exportAgentVersion(
  agentId: string,
  body: unknown,
  sources: PortableProjectSources,
): Promise<PlatformExportOutcome> {
  const request = PlatformExportRequestSchema.safeParse(body);
  if (!request.success) {
    return {
      ok: false,
      result: problem(
        PLATFORM_EXPORT_PROBLEM_CODES.invalid_platform_export,
        'invalid_platform_export',
        'The request is not a platform export request.',
        issueLines(request.error),
      ),
    };
  }
  const { version, platform, options } = request.data;
  const target = platformTarget(platform);
  if (target === undefined) {
    throw new Error(`The platform ${platform} passed validation but has no registered target.`);
  }

  let built: Awaited<ReturnType<typeof buildPortableProject>>;
  try {
    built = await buildPortableProject(agentId, version, sources);
  } catch (error) {
    if (error instanceof PlatformExportTooLargeError) return tooLarge(error.bytes);
    throw error;
  }
  if (!built.ok) return built;

  const compiled = compileForPlatform(target, built.project, options);
  if (!compiled.ok) {
    const { code, message, details } = compiled.refusal;
    return {
      ok: false,
      result: problem(PLATFORM_EXPORT_PROBLEM_CODES[code], code, message, details),
    };
  }

  const report = [...built.dropped, ...compiled.report];
  const files = [
    ...compiled.files.map((file) => wireFile(file.path, file.content)),
    wireFile(REPORT_FILE, formatPlatformReport(platform, report)),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const bytes = files.reduce((sum, file) => sum + decodedBytes(file), 0);
  if (bytes > PLATFORM_EXPORT_MAX_BYTES) return tooLarge(bytes);

  const response = PlatformExportResponseSchema.parse({
    agentId,
    version,
    platform,
    files,
    report,
  });
  return { ok: true, agentName: built.project.root, response };
}
