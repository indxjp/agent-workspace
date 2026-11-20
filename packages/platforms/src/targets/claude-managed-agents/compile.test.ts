import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PortableProjectSchema,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import {
  CREDENTIAL_PATTERNS,
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
  assertVerdictInvariants,
  expectGoldenFiles,
  runPlatformConformance,
} from '../../testing/index.js';
import {
  type Agent,
  agentFrontmatter,
  compiled,
  rootOf,
  sample,
  text,
  verdictOf,
  withRoot,
} from '../../testing/claude-managed-agents-compile.test-support.js';
import {
  AW_TOOLS_SERVER_NAME,
  CREDENTIAL_PLAN_FILE,
  MULTIAGENT_TYPE,
  claudeManagedAgentsTarget,
} from './index.js';

const GOLDEN = join(import.meta.dirname, '__golden__');

describe('claude-managed-agents target', () => {
  it('passes the platform conformance suite', () => {
    runPlatformConformance(claudeManagedAgentsTarget);
  });
});

describe('claude-managed-agents goldens', () => {
  for (const name of ['full', 'no-tool-endpoint'] as const) {
    const dir = join(GOLDEN, name);
    const input =
      name === 'full' ? SAMPLE_PORTABLE_PROJECT : SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT;

    // input.json, not project.json: Nx reads every project.json as a project definition.
    const load = (): PortableProject =>
      PortableProjectSchema.parse(JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8')));

    it(`${name}: input.json is the shared sample`, () => {
      expect(load()).toEqual(PortableProjectSchema.parse(input));
    });

    it(`${name}: emits exactly the golden tree and report`, () => {
      const project = load();
      const result = compileForPlatform(claudeManagedAgentsTarget, project, {});
      expectGoldenFiles(result, dir);
      assertVerdictInvariants(claudeManagedAgentsTarget, project, result);
    });
  }

  it('full: lists the five kinds of files', () => {
    const { files } = compiled(sample);
    expect([...files.keys()]).toEqual([
      'agents/billing-specialist.md',
      'agents/support-triage.md',
      'aw-vault-credentials.json',
      'environments/default.yaml',
      'skills/refund-policy/SKILL.md',
      'vaults/support-triage.yaml',
    ]);
  });

  it('no-tool-endpoint: has no aw-tools, drops the code tool and plans only the zendesk credential', () => {
    const project = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT);
    const { files, report } = compiled(project);
    expect(text(files, 'agents/support-triage.md')).not.toContain(AW_TOOLS_SERVER_NAME);
    expect(verdictOf(report, 'support-triage.tools.2')).toMatchObject({
      verdict: 'dropped',
      code: 'code_tool_needs_public_mcp',
    });
    const plan = JSON.parse(text(files, CREDENTIAL_PLAN_FILE)) as { credentials: unknown[] };
    expect(plan.credentials).toEqual([
      {
        type: 'static_bearer',
        mcp_server_url: 'https://mcp.example.com/zendesk',
        secretRef: 'ZENDESK_TOKEN',
      },
    ]);
  });
});

describe('claude-managed-agents secrets', () => {
  it('names a secret only in the credential plan and carries no credential', () => {
    const { files, report } = compiled(sample);
    for (const [path, content] of files) {
      if (typeof content !== 'string') continue;
      for (const pattern of CREDENTIAL_PATTERNS) expect(content).not.toMatch(pattern);
      if (path === CREDENTIAL_PLAN_FILE) continue;
      expect(content).not.toContain('ZENDESK_TOKEN');
      expect(content).not.toContain('ACME_TOOL_ENDPOINT_TOKEN');
    }
    expect(JSON.stringify(report)).not.toMatch(/ZENDESK_TOKEN|ACME_TOOL_ENDPOINT_TOKEN/u);
  });

  it('emits no vault and no plan when no emitted server has auth', () => {
    const root = rootOf(sample);
    const { files } = compiled(
      withRoot(
        { tools: root.tools.filter((tool) => tool.kind !== 'mcp' && tool.kind !== 'code') },
        {
          ...sample,
          toolEndpoint: undefined,
        },
      ),
    );
    expect(files.has(CREDENTIAL_PLAN_FILE)).toBe(false);
    expect([...files.keys()].some((path) => path.startsWith('vaults/'))).toBe(false);
  });
});

describe('claude-managed-agents determinism', () => {
  it('compiles twice to the same files', () => {
    expect(compiled(sample)).toEqual(compiled(sample));
  });

  it('does not depend on the order of agents or skills in the input', () => {
    const shuffled: PortableProject = {
      ...sample,
      agents: [...sample.agents].reverse(),
      skills: [...sample.skills].reverse(),
    };
    expect([...compiled(shuffled).files]).toEqual([...compiled(sample).files]);
  });
});

describe('claude-managed-agents emitted shape', () => {
  it('lists subagents as agent entries with a relative path id under multiagent, on the root only', () => {
    const { files } = compiled(sample);
    expect(agentFrontmatter(files, 'support-triage')['multiagent']).toEqual({
      type: MULTIAGENT_TYPE,
      subagents: {
        type: 'enabled',
        inline_agents: { type: 'disabled' },
        predefined_agents: [{ type: 'agent', id: './billing-specialist.md' }],
      },
      workflows: { type: 'disabled' },
    });
    expect(agentFrontmatter(files, 'billing-specialist')['multiagent']).toBeUndefined();
  });

  it('copies skill bytes unchanged', () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const project: PortableProject = {
      ...sample,
      skills: sample.skills.map((skill) => ({
        ...skill,
        files: [...skill.files, { path: 'assets/blob.bin', content: bytes }],
      })),
    };
    const { files } = compiled(project);
    expect(files.get('skills/refund-policy/assets/blob.bin')).toEqual(bytes);
    expect(files.get('skills/refund-policy/SKILL.md')).toBe(
      sample.skills[0]?.files.find((file) => file.path === 'SKILL.md')?.content,
    );
  });

  it('does not emit agents outside the root and its subagents', () => {
    const extra: Agent = { ...rootOf(sample), name: 'bystander', subagents: [] };
    const { files } = compiled({ ...sample, agents: [...sample.agents, extra] });
    expect(files.has('agents/bystander.md')).toBe(false);
  });
});
