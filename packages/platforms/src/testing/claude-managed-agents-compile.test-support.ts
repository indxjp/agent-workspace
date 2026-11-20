import type { FieldVerdict, PlatformFile } from '@indx-workspace/contracts/platforms';
import {
  PortableProjectSchema,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import { parse } from 'yaml';

import { compileForPlatform } from '../compile.js';
import { claudeManagedAgentsTarget } from '../targets/claude-managed-agents/index.js';
import { SAMPLE_PORTABLE_PROJECT } from './index.js';

export type Agent = PortableProject['agents'][number];
export type Tool = Agent['tools'][number];
type Options = Parameters<typeof claudeManagedAgentsTarget.compile>[1];

export const sample = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
export const ENDPOINT_URL = 'https://aw.example.com/mcp/projects/acme-support';

export function rootOf(project: PortableProject): Agent {
  const root = project.agents.find((agent) => agent.name === project.root);
  if (root === undefined) throw new Error('the test project has no root');
  return root;
}

/** The sample with the root agent patched; the result is not re-validated, so a test may break a bound. */
export function withRoot(patch: Partial<Agent>, base: PortableProject = sample): PortableProject {
  return {
    ...base,
    agents: base.agents.map((agent) => (agent.name === base.root ? { ...agent, ...patch } : agent)),
  };
}

export function compiled(
  project: PortableProject,
  options: unknown = {},
): { files: Map<string, PlatformFile['content']>; report: readonly FieldVerdict[] } {
  const result = compileForPlatform(claudeManagedAgentsTarget, project, options);
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  return {
    files: new Map(result.files.map((file) => [file.path, file.content])),
    report: result.report,
  };
}

export function text(files: Map<string, PlatformFile['content']>, path: string): string {
  const content = files.get(path);
  if (typeof content !== 'string') throw new Error(`${path} is not an emitted text file`);
  return content;
}

export function frontmatterOf(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(content);
  const parsed: unknown = parse(match?.[1] ?? '', { strict: true });
  return parsed as Record<string, unknown>;
}

export function agentFrontmatter(
  files: Map<string, PlatformFile['content']>,
  name: string,
): Record<string, unknown> {
  return frontmatterOf(text(files, `agents/${name}.md`));
}

export function refusalOf(project: PortableProject, options: Options = {}): string {
  const result = claudeManagedAgentsTarget.compile(project, options);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal.code;
}

export function mcp(index: number): Tool {
  return {
    kind: 'mcp',
    name: `server-${index}`,
    transport: 'streamable-http',
    url: `https://mcp.example.com/${index}`,
  };
}

export function verdictOf(report: readonly FieldVerdict[], path: string): FieldVerdict {
  const entry = report.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`no verdict for ${path}`);
  return entry;
}

export function withNetworking(
  rootUnrestricted: boolean,
  subagentUnrestricted: boolean,
): PortableProject {
  return {
    ...sample,
    agents: sample.agents.map((agent) => {
      if (agent.name === sample.root) {
        return {
          ...agent,
          permissions: { ...agent.permissions, unrestrictedNetwork: rootUnrestricted },
        };
      }
      if (agent.name === 'billing-specialist') {
        return {
          ...agent,
          permissions: { ...agent.permissions, unrestrictedNetwork: subagentUnrestricted },
        };
      }
      return agent;
    }),
  };
}

export function authed(
  name: string,
  url: string,
  secretRef: string,
  scheme: 'bearer' | 'api-key' | 'oauth2' = 'bearer',
): Tool {
  return { kind: 'mcp', name, transport: 'streamable-http', url, auth: { scheme, secretRef } };
}

export function withSubagent(tools: Tool[], base: PortableProject = sample): PortableProject {
  return {
    ...base,
    agents: base.agents.map((agent) =>
      agent.name === 'billing-specialist' ? { ...agent, tools } : agent,
    ),
  };
}
