import { PortableProjectSchema } from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { capabilityOfPath, dropped, mapped, native, portableFieldPaths } from './paths.js';
import {
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITH_EXTENSIONS,
} from './testing/sample.js';

const sample = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);

describe('portableFieldPaths', () => {
  it('lists every reportable field of the sample once, in the documented order', () => {
    expect(portableFieldPaths(sample)).toEqual([
      'toolEndpoint',
      'support-triage.description',
      'support-triage.instructions',
      'support-triage.model',
      'support-triage.permissions.readFiles',
      'support-triage.permissions.writeFiles',
      'support-triage.permissions.runCommands',
      'support-triage.permissions.unrestrictedNetwork',
      'support-triage.tools.0',
      'support-triage.tools.1',
      'support-triage.tools.2',
      'support-triage.tools.3',
      'support-triage.tools.4',
      'support-triage.tools.5',
      'support-triage.skills.0',
      'support-triage.knowledge.0',
      'support-triage.knowledge.1',
      'support-triage.subagents.0',
      'support-triage.limits.maxTurns',
      'support-triage.limits.maxBudgetUsd',
      'billing-specialist.description',
      'billing-specialist.instructions',
      'billing-specialist.model',
      'billing-specialist.permissions.readFiles',
      'billing-specialist.permissions.writeFiles',
      'billing-specialist.permissions.runCommands',
      'billing-specialist.permissions.unrestrictedNetwork',
      'billing-specialist.skills.0',
    ]);
  });

  it('lists only instructions and the four permissions for a minimal agent', () => {
    const minimal = PortableProjectSchema.parse({
      root: 'solo',
      agents: [
        {
          apiVersion: sample.agents[0]?.apiVersion,
          kind: sample.agents[0]?.kind,
          name: 'solo',
          instructions: 'Do the work.',
          permissions: {
            readFiles: false,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        },
      ],
    });
    expect(portableFieldPaths(minimal)).toEqual([
      'solo.instructions',
      'solo.permissions.readFiles',
      'solo.permissions.writeFiles',
      'solo.permissions.runCommands',
      'solo.permissions.unrestrictedNetwork',
    ]);
  });

  it('lists an absent description only when asked, in its usual slot', () => {
    const bare = { ...sample.agents[0], description: undefined };
    const project = PortableProjectSchema.parse({
      ...sample,
      agents: [bare, ...sample.agents.slice(1)],
    });
    expect(portableFieldPaths(project)).not.toContain('support-triage.description');
    const paths = portableFieldPaths(project, { withGeneratedDescriptions: true });
    expect(paths.indexOf('support-triage.description')).toBe(
      paths.indexOf('support-triage.instructions') - 1,
    );
  });

  it('lists engine and extension paths when an agent has them', () => {
    const paths = portableFieldPaths(
      PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT_WITH_EXTENSIONS),
    );
    expect(paths).toContain('support-triage.engine');
    expect(paths).toContain('support-triage.extensions.engines.claude-agent-sdk');
    expect(paths).toContain('support-triage.extensions.platforms.copilot-studio');
    expect(paths).not.toContain('toolEndpoint');
  });
});

describe('capabilityOfPath', () => {
  it('maps every tool kind and transport', () => {
    const at = (index: number): string | null =>
      capabilityOfPath(sample, `support-triage.tools.${index}`);
    expect([0, 1, 2, 3, 4, 5].map(at)).toEqual([
      'mcpRemote',
      'mcpStdio',
      'codeTools',
      'openapiTools',
      'builtinTools',
      'builtinTools',
    ]);
  });

  it('maps every knowledge kind', () => {
    const connector = PortableProjectSchema.parse({
      ...SAMPLE_PORTABLE_PROJECT,
      agents: [
        {
          ...SAMPLE_PORTABLE_PROJECT.agents[0],
          knowledge: [
            { kind: 'files', paths: ['knowledge/faq.md'] },
            { kind: 'url', url: 'https://help.example.com' },
            { kind: 'connector', name: 'sharepoint' },
          ],
        },
        SAMPLE_PORTABLE_PROJECT.agents[1],
      ],
    });
    expect(
      [0, 1, 2].map((i) => capabilityOfPath(connector, `support-triage.knowledge.${i}`)),
    ).toEqual(['knowledgeFiles', 'knowledgeUrls', 'knowledgeConnectors']);
  });

  it('maps the simple fields and engine extensions', () => {
    const extended = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT_WITH_EXTENSIONS);
    expect(
      [
        'description',
        'instructions',
        'model',
        'engine',
        'permissions.readFiles',
        'skills.0',
        'subagents.0',
        'limits.maxTurns',
        'extensions.engines.claude-agent-sdk',
      ].map((field) => capabilityOfPath(extended, `support-triage.${field}`)),
    ).toEqual([
      'description',
      'instructions',
      'model',
      'engine',
      'permissions',
      'skills',
      'subagents',
      'limits',
      'engine',
    ]);
  });

  it('is null for toolEndpoint, platform extensions, unknown agents, fields and indexes', () => {
    const extended = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT_WITH_EXTENSIONS);
    for (const path of [
      'toolEndpoint',
      'support-triage.extensions.platforms.copilot-studio',
      'nobody.instructions',
      'support-triage.constructor',
      'support-triage.tools.99',
      'support-triage.knowledge.99',
    ]) {
      expect(capabilityOfPath(extended, path), path).toBeNull();
    }
  });
});

describe('verdict builders', () => {
  it('build frozen verdicts, and only a drop carries a code', () => {
    expect(native('a', 'n')).toEqual({ path: 'a', verdict: 'native', note: 'n' });
    expect(mapped('a', 'n')).toEqual({ path: 'a', verdict: 'mapped', note: 'n' });
    const drop = dropped('a', 'field_unsupported', 'n');
    expect(drop).toEqual({ path: 'a', verdict: 'dropped', code: 'field_unsupported', note: 'n' });
    expect(Object.isFrozen(drop)).toBe(true);
  });
});
