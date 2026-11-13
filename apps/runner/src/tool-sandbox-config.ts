import { type ToolSandboxRequest } from '@indx-workspace/contracts/agent-versions';
import type { RuntimeConfig } from '@agent-workspace/runtime/driver';
import {
  type OpenSession,
  type ToolSandboxSession,
  TOOL_SANDBOX_ENGINE,
} from './tool-sandbox-contracts.js';
import type { SandboxContext } from './tool-sandbox-context.js';

const MIB = 1024 * 1024;

const TIMEOUT_MARGIN_SECONDS = 120;

function diskMbFor(request: ToolSandboxRequest): number {
  const bytes = request.manifest.tools.reduce((sum, tool) => sum + tool.bundleBase64.length, 0);
  return Math.max(64, Math.ceil((bytes * 3) / MIB) + 16);
}

export function configFor(
  context: SandboxContext,
  session: OpenSession,
  request: ToolSandboxRequest,
): RuntimeConfig {
  const domains = request.allowedDomains ?? [];
  const deadlineSeconds =
    context.options.timeoutSeconds === undefined
      ? session.timeoutSeconds
      : Math.min(
          session.timeoutSeconds ?? context.options.timeoutSeconds,
          context.options.timeoutSeconds,
        );
  const timeoutSeconds =
    deadlineSeconds === undefined ? undefined : deadlineSeconds + TIMEOUT_MARGIN_SECONDS;
  return {
    sessionId: session.sessionId,
    engine: TOOL_SANDBOX_ENGINE,
    workspacePath: `${session.workspacesRoot}/tool-sandbox/${encodeURIComponent(session.key)}`,
    runtimeProfileId: `tool-sandbox:${session.key}:${request.key}`,
    runSpec: {
      runtimeProfileId: 'tool-sandbox',
      driver: context.options.driverId ?? 'docker',
      // No declared domain means no egress at all (TS5).
      networkPolicy: domains.length === 0 ? 'none' : 'restricted',
      filesystem: 'read-write',
      diskMb: diskMbFor(request),
      ...(domains.length === 0 ? {} : { allowedDomains: domains }),
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    },
  };
}

export function sessionTags(session: Omit<ToolSandboxSession, 'key'>): Record<string, string> {
  return { awWorkspace: session.workspaceId, awSession: session.sessionId };
}
