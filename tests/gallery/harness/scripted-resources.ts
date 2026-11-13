import { AgentVersionListResponseSchema } from '@indx-workspace/contracts/agent-versions';
import {
  FileResourceSchema,
  fileRouteId,
  type FileResource,
} from '@indx-workspace/contracts/files';
import { SkillDetailSchema } from '@indx-workspace/contracts/skills';
import { fixtures, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';
import type { ScriptedOptions } from './scripted-workspace-types.ts';

const WRITTEN_AT = '2026-10-17T10:00:00.000Z';

/** What one level under `directory` holds, as `GET /api/files?path=` reports it. */
function listLevel(files: ReadonlyMap<string, Uint8Array>, directory: string): FileResource[] {
  const prefix = `${directory}/`;
  const found = new Map<string, FileResource>();
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const entryPath = slash === -1 ? path : `${prefix}${rest.slice(0, slash)}`;
    found.set(
      entryPath,
      FileResourceSchema.parse({
        id: fileRouteId(entryPath),
        path: entryPath,
        kind: slash === -1 ? 'file' : 'folder',
        sizeBytes: slash === -1 ? bytes.byteLength : null,
        contentType: null,
        lastModified: slash === -1 ? WRITTEN_AT : null,
      }),
    );
  }
  return [...found.values()];
}

export function scriptedResourceResponse(
  request: RecordedRequest,
  files: ReadonlyMap<string, Uint8Array>,
  options: ScriptedOptions,
  agentId: string,
): Response | null {
  const { pathname } = request.url;
  if (request.method === 'GET' && pathname === '/api/files') {
    const directory = (request.url.searchParams.get('path') ?? '').replace(/\/+$/u, '');
    return jsonResponse(200, { files: listLevel(files, directory) });
  }
  const download = /^\/api\/files\/([^/]+)$/u.exec(pathname);
  if (request.method === 'GET' && download?.[1] !== undefined) {
    for (const [path, bytes] of files) {
      if (fileRouteId(path) !== download[1]) continue;
      const name = encodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename*=UTF-8''${name}`,
        },
      });
    }
  }
  if (options.version !== undefined) {
    const { body, skillFileCounts } = options.version;
    if (request.method === 'GET' && pathname === `/api/agents/${agentId}/versions`) {
      const version = fixtures.agentVersion({ agentId: agentId, number: 1, body });
      return jsonResponse(
        200,
        AgentVersionListResponseSchema.parse({
          items: [version],
          pointers: [fixtures.agentVersionPointer({ number: 1 })],
          materialised: 1,
        }),
      );
    }
    const skill = /^\/api\/skills\/([^/]+)$/u.exec(pathname);
    const fileCount = skillFileCounts[skill?.[1] ?? ''];
    if (request.method === 'GET' && skill?.[1] !== undefined && fileCount !== undefined) {
      return jsonResponse(200, {
        skill: SkillDetailSchema.parse({
          id: skill[1],
          name: skill[1],
          enabled: true,
          description: null,
          fileCount,
          createdAt: WRITTEN_AT,
          updatedAt: WRITTEN_AT,
          source: null,
          instructions: null,
          allowedTools: null,
          files: [],
          revisions: [
            {
              // The first `aw skills publish` is revision 1; the pin is checked against it, not copied.
              number: 1,
              fileCount,
              publishedAt: WRITTEN_AT,
            },
          ],
        }),
      });
    }
  }

  return null;
}
