import type {
  FieldVerdict,
  PlatformCapabilities,
  PlatformCapabilityKey,
  PlatformDropCode,
} from '@indx-workspace/contracts/platforms';
import {
  PORTABLE_AGENT_API_VERSION,
  PORTABLE_AGENT_KIND,
  PortableProjectSchema,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import { z } from 'zod';

import { capabilityOfPath, dropped, mapped, native, portableFieldPaths } from '../paths.js';
import type { PlatformCompileResult, PlatformImportResult, PlatformTarget } from '../port.js';

export type FakeOptions = Record<string, never>;

/** Mixed on purpose: native, mapped and unsupported capabilities all appear. */
const FAKE_CAPABILITIES: PlatformCapabilities = {
  description: 'native',
  instructions: 'native',
  model: 'mapped',
  engine: 'unsupported',
  permissions: 'unsupported',
  mcpRemote: 'native',
  mcpStdio: 'unsupported',
  codeTools: 'mapped',
  openapiTools: 'mapped',
  builtinTools: 'unsupported',
  skills: 'mapped',
  knowledgeFiles: 'mapped',
  knowledgeUrls: 'native',
  knowledgeConnectors: 'unsupported',
  subagents: 'mapped',
  limits: 'unsupported',
};

const DROP_CODE_OF_CAPABILITY: Partial<Record<PlatformCapabilityKey, PlatformDropCode>> = {
  mcpStdio: 'stdio_mcp_unsupported',
  builtinTools: 'builtin_unsupported',
  skills: 'skills_unsupported',
  knowledgeFiles: 'knowledge_unsupported',
  knowledgeUrls: 'knowledge_unsupported',
  knowledgeConnectors: 'knowledge_unsupported',
  subagents: 'subagents_unsupported',
  limits: 'limits_unsupported',
  permissions: 'permissions_unsupported',
};

function verdictFor(target: PlatformTarget, project: PortableProject, path: string): FieldVerdict {
  if (path === 'toolEndpoint') return mapped(path, 'named as the host of the code tools');
  const platformId = /\.extensions\.platforms\.(.+)$/u.exec(path)?.[1];
  if (platformId !== undefined) {
    return platformId === target.id
      ? mapped(path, 'read as this target’s options')
      : dropped(path, 'field_unsupported', `options for ${platformId}, not this target`);
  }
  const capability = capabilityOfPath(project, path);
  if (capability === null)
    return dropped(path, 'field_unsupported', 'not governed by a capability');
  const support = target.capabilities[capability];
  if (capability === 'codeTools' && project.toolEndpoint === undefined) {
    return dropped(path, 'code_tool_needs_public_mcp', 'no public tool endpoint to run it on');
  }
  if (support === 'unsupported') {
    return dropped(
      path,
      DROP_CODE_OF_CAPABILITY[capability] ?? 'field_unsupported',
      `${target.id} has no ${capability}`,
    );
  }
  return support === 'native' ? native(path, 'carried as is') : mapped(path, 'carried translated');
}

/**
 * A pure reference target for the kit's own tests: it emits `agent.json` and reports every field
 * `native`, `mapped` or `dropped` by its capabilities, with the ADR-0133 D8 drop codes. Override a
 * member to build the broken target a negative test needs. Not exported from the package root.
 */
export function fakeTarget(
  overrides: Partial<PlatformTarget<FakeOptions>> = {},
): PlatformTarget<FakeOptions> {
  const target: PlatformTarget<FakeOptions> = {
    id: 'copilot-studio',
    displayName: 'Fake target',
    docsUrl: 'https://example.com/fake-target',
    capabilities: FAKE_CAPABILITIES,
    optionsSchema: z.object({}).strict(),
    compile(project): PlatformCompileResult {
      const root = project.agents.find((agent) => agent.name === project.root);
      const agentJson = JSON.stringify(
        { name: root?.name, description: root?.description, instructions: root?.instructions },
        null,
        2,
      );
      return {
        ok: true,
        files: [{ path: 'agent.json', content: `${agentJson}\n` }],
        report: portableFieldPaths(project).map((path) => verdictFor(this, project, path)),
      };
    },
    import(files): PlatformImportResult {
      const file = files.find((candidate) => candidate.path === 'agent.json');
      if (file === undefined || typeof file.content !== 'string') {
        return {
          ok: false,
          refusal: { code: 'platform_agent_not_found', message: 'no agent.json', details: [] },
        };
      }
      const { name, description, instructions } = JSON.parse(file.content) as {
        name: string;
        description?: string;
        instructions: string;
      };
      const project = PortableProjectSchema.parse({
        root: name,
        agents: [
          {
            apiVersion: PORTABLE_AGENT_API_VERSION,
            kind: PORTABLE_AGENT_KIND,
            name,
            ...(description === undefined ? {} : { description }),
            instructions,
            permissions: {
              readFiles: false,
              writeFiles: false,
              runCommands: false,
              unrestrictedNetwork: false,
            },
          },
        ],
      });
      return { ok: true, project, report: [] };
    },
    ...overrides,
  };
  return target;
}
