/**
 * The HTTP edge of `POST /api/agents/:id/platform-exports` and `.../platform-archives` (issue
 * #968): authorisation (the agent-version routes', so the agent's ownership decides), the bounded
 * body, and the workspace-bound stores the export reads. Both routes share one export; the archive
 * only changes how the files travel.
 */
import { PLATFORM_EXPORT_REQUEST_MAX_BYTES } from '@indx-workspace/contracts/platforms';
import { encodeUstar } from '@agent-workspace/runtime';

import { authoriseAgentVersionRoute } from '../agent-versions/http';
import { problem, type ApiResult } from '../agents/handlers';
import { toResponse } from '../agents/http';
import { currentConnectorsRuntime } from '../connectors/runtime';
import { currentEndpointClientsRuntime } from '../endpoint-clients/runtime';
import { readPublicUrl } from '../endpoints/public-url';
import { currentFilesRuntime } from '../files/runtime';
import { readBoundedJson } from '../http/json-transport';
import { currentSkillsRuntime } from '../skills/runtime';
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
  const authorised = await authoriseAgentVersionRoute(request, context);
  if (!authorised.ok) return authorised.response;
  const { agent, principal, store } = authorised.scope;

  const read = await readBoundedJson(request, {
    maxBytes: PLATFORM_EXPORT_REQUEST_MAX_BYTES,
    problem,
  });
  if (!read.ok) return toResponse(read.result);

  const connectors = currentConnectorsRuntime();
  if (connectors === null) return toResponse(notConfigured('Connectors'));
  const skills = currentSkillsRuntime();
  if (skills === null) return toResponse(notConfigured('Skills'));
  const skillStore = skills.store.forWorkspace(principal.workspaceId);
  const filesRuntime = currentFilesRuntime();
  if (filesRuntime === null) return toResponse(notConfigured('Files'));
  const fileStore = filesRuntime.store.forWorkspace(principal.workspaceId);
  const endpointClients = currentEndpointClientsRuntime();
  const publicUrl = readPublicUrl(process.env);

  const sources: PortableProjectSources = {
    versions: store,
    connectors: connectors.connectors.forWorkspace(principal.workspaceId),
    workspaceFile: async (path) => (await fileStore.get(path))?.body ?? null,
    endpointClients: async () => (await endpointClients?.list(principal.workspaceId)) ?? [],
    publicOrigin: publicUrl.ok ? publicUrl.origin : null,
    skillFiles: async (name) =>
      (await walkFiles(skillStore, skillFilesPrefix(name))).map((file) => ({
        path: file.relativePath,
        sizeBytes: file.sizeBytes,
        read: async () => {
          const object = await skillStore.get(file.key);
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
  if (!outcome.ok) return toResponse(outcome.result);
  if (format === 'json') return toResponse({ status: 200, body: outcome.response });

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
      'cache-control': 'no-store',
    },
  });
}
