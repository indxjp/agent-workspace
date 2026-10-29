/**
 * The HTTP edge of `POST /api/agents/:id/platform-exports` and `.../platform-archives` (issue
 * #968): authorisation (the agent-version routes', so the agent's ownership decides), the bounded
 * body, and the workspace-bound stores the export reads. Both routes share one export; the archive
 * only changes how the files travel.
 */
import { PLATFORM_EXPORT_REQUEST_MAX_BYTES } from '@indx-workspace/contracts/platforms';
import { readWhole } from '@agent-workspace/core/storage/streams';
import { encodeUstar } from '@agent-workspace/runtime/transfer';

import { authoriseAgentVersionRoute } from '../agent-versions/http';
import { applicationContext } from '../application-context';
import { problem, type ApiResult } from '../http/result';
import { apiResultResponse } from '../http/json-transport';
import { readPublicUrl } from '../endpoints/public-url';
import { readBoundedJson } from '../http/json-transport';
import { skillFilesPrefix } from '../skills/keys';
import { walkFiles } from '../skills/tree';
import { exportAgentVersion, exportFileBytes } from './export';
import type { PortableProjectSources } from './project';

const TAR_FILE_MODE = 0o644;

function notConfigured(what: string): ApiResult {
  return problem(
    503,
    'agent_policy_not_configured',
    `${what} are not configured for this deployment.`,
  );
}

/** The archive's file name: `<agent>-<platform>-v<n>.tar`; the agent name is kebab by then. */
function archiveName(agentName: string, platform: string, version: number): string {
  return `${agentName}-${platform}-v${version}.tar`;
}

/**
 * Authorise onto the agent `:id` names, read the request, and answer the export as JSON, or as a
 * tar of the same files when `format` is `'tar'`.
 */
export async function servePlatformExport(
  request: Request,
  context: { params: Promise<{ id: string }> },
  format: 'json' | 'tar',
): Promise<Response> {
  const authorised = await authoriseAgentVersionRoute(
    request,
    context,
    format === 'json' ? 'export' : 'export-archive',
  );
  if (!authorised.ok) return authorised.response;
  const { agent, principal, store } = authorised.scope;

  const read = await readBoundedJson(request, {
    maxBytes: PLATFORM_EXPORT_REQUEST_MAX_BYTES,
    problem,
  });
  if (!read.ok) return apiResultResponse(read.result);

  const app = applicationContext();
  const connectors = app?.connectors.kind === 'serving' ? app.connectors.runtime : null;
  if (connectors === null) return apiResultResponse(notConfigured('Connectors'));
  const skills = app?.skills.kind === 'serving' ? app.skills.runtime : null;
  if (skills === null) return apiResultResponse(notConfigured('Skills'));
  const skillStore = skills.store.forWorkspace(principal.workspaceId);
  const filesRuntime = app?.files.kind === 'serving' ? app.files.runtime : null;
  if (filesRuntime === null) return apiResultResponse(notConfigured('Files'));
  const fileStore = filesRuntime.store.forWorkspace(principal.workspaceId);
  const endpointClients = app?.endpointClients ?? null;
  const publicUrl = readPublicUrl(process.env);

  const sources: PortableProjectSources = {
    versions: store,
    connectors: connectors.connectors.forWorkspace(principal.workspaceId),
    workspaceFile: async (path) => (await readWhole(fileStore, path))?.body ?? null,
    endpointClients: async () => (await endpointClients?.list(principal.workspaceId)) ?? [],
    publicOrigin: publicUrl.ok ? publicUrl.origin : null,
    skillFiles: async (name) =>
      (await walkFiles(skillStore, skillFilesPrefix(name))).map((file) => ({
        path: file.relativePath,
        sizeBytes: file.sizeBytes,
        read: async () => {
          const object = await readWhole(skillStore, file.key);
          if (object === null) {
            // Listed a moment ago, gone now: a concurrent delete raced this export. Failing (a 500)
            // rather than exporting a partial skill, as `exportSkill` does (ADR-0015).
            throw new Error(`The skill file ${file.key} was listed but could not be read back.`);
          }
          return object.body;
        },
      })),
  };

  const outcome = await exportAgentVersion(agent.id, read.value, sources);
  if (!outcome.ok) return apiResultResponse(outcome.result);
  if (format === 'json') return apiResultResponse({ status: 200, body: outcome.response });

  const { files, platform, version } = outcome.response;
  const archive = encodeUstar(
    files.map((file) => ({
      path: file.path,
      type: 'file' as const,
      mode: TAR_FILE_MODE,
      data: exportFileBytes(file),
    })),
  );
  return new Response(Buffer.from(archive), {
    status: 200,
    headers: {
      'content-type': 'application/x-tar',
      'content-disposition': `attachment; filename="${archiveName(outcome.agentName, platform, version)}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
