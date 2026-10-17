import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import {
  PORTABLE_AGENT_API_VERSION,
  PORTABLE_AGENT_KIND,
  PortableProjectSchema,
} from '@indx-workspace/contracts/portable-agent';
import { MASTRA_DEFAULT_MODELS } from '@agent-workspace/engine-mastra';
import { compileForPlatform, platformTarget } from '@indx-workspace/platforms';
import { SAMPLE_PORTABLE_PROJECT } from '@indx-workspace/platforms/testing';
import { describe, expect, it } from 'vitest';

/** One row per ejected engine; the manifest is the engine adapter whose pins the project must copy. */
const EJECTS = [
  { id: 'eject-claude-agent-sdk', engineManifest: 'packages/engine-claude-agent-sdk/package.json' },
  { id: 'eject-mastra', engineManifest: 'packages/engine-mastra/package.json' },
  { id: 'eject-openai-agents', engineManifest: 'packages/engine-openai-agents/package.json' },
] as const;

type Manifest = {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
};

function manifestAt(path: string): Manifest {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8'),
  ) as Manifest;
}

const rootManifest = manifestAt('package.json');

/** The repository installs TypeScript through an npm alias; a project cannot, so it pins the version. */
function unaliased(version: string | undefined): string | undefined {
  return version?.replace(/^npm:.*@/u, '');
}

describe.each(EJECTS)('$id pins', ({ id, engineManifest }) => {
  const target = platformTarget(id);
  if (target === undefined) throw new Error(`${id} is not registered`);
  const result = compileForPlatform(
    target,
    PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT),
    {},
  );
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
  const file = result.files.find((candidate) => candidate.path === 'package.json');
  if (typeof file?.content !== 'string') throw new Error('no package.json');
  const emitted = JSON.parse(file.content) as Manifest;
  const engine = manifestAt(engineManifest);
  const known: Record<string, string> = {
    ...rootManifest.devDependencies,
    ...engine.devDependencies,
    ...engine.dependencies,
    '@indx-workspace/sdk': CONTRACTS_VERSION,
  };
  known['typescript'] = unaliased(known['typescript']) ?? '';

  it('pins every dependency to the version this repository runs', () => {
    const pins = Object.entries({ ...emitted.dependencies, ...emitted.devDependencies });
    expect(pins.length).toBeGreaterThan(0);
    for (const [name, version] of pins) {
      expect([name, version]).toEqual([name, known[name]]);
    }
  });

  it('pins exact versions, not ranges or aliases', () => {
    for (const version of Object.values({ ...emitted.dependencies, ...emitted.devDependencies })) {
      expect(version).not.toMatch(/^[\^~><*]/u);
      expect(version).not.toMatch(/^npm:/u);
    }
  });
});

describe('eject-mastra default model', () => {
  it('is the default model of the Mastra engine', () => {
    const target = platformTarget('eject-mastra');
    if (target === undefined) throw new Error('eject-mastra is not registered');
    const minimal = PortableProjectSchema.parse({
      root: 'helper',
      agents: [
        {
          apiVersion: PORTABLE_AGENT_API_VERSION,
          kind: PORTABLE_AGENT_KIND,
          name: 'helper',
          instructions: '',
          permissions: {
            readFiles: false,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        },
      ],
      skills: [],
      knowledgeFiles: [],
      openapiSpecs: [],
    });
    const result = compileForPlatform(target, minimal, {});
    if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
    const agent = result.files.find((candidate) => candidate.path === 'src/agent.ts');
    expect(agent?.content).toContain(`anthropic/${MASTRA_DEFAULT_MODELS.anthropic}`);
  });
});
