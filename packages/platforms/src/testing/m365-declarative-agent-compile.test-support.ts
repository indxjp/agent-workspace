import type { FieldVerdict, PlatformFile } from '@indx-workspace/contracts/platforms';
import {
  PortableProjectSchema,
  type PortableProject,
  type PortableProjectInput,
} from '@indx-workspace/contracts/portable-agent';

import { compileForPlatform } from '../compile.js';
import { m365DeclarativeAgentTarget } from '../targets/m365-declarative-agent/index.js';
import { assertVerdictInvariants } from './invariants.js';
import { SAMPLE_PORTABLE_PROJECT } from './sample.js';

export const target = m365DeclarativeAgentTarget;

type AgentInput = PortableProjectInput['agents'][number];

/** The sample project, parsed. */
export function sampleProject(): PortableProject {
  return PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
}

/** The sample with the root agent changed. */
export function projectWith(patch: Partial<AgentInput>): PortableProject {
  return PortableProjectSchema.parse({
    ...SAMPLE_PORTABLE_PROJECT,
    agents: SAMPLE_PORTABLE_PROJECT.agents.map((agent, index) =>
      index === 0 ? { ...agent, ...patch } : agent,
    ),
  });
}

export function compile(project: PortableProject, options: unknown = {}) {
  return compileForPlatform(target, project, options);
}

export function compiled(project: PortableProject, options: unknown = {}) {
  const result = compile(project, options);
  if (!result.ok)
    throw new Error(`refused: ${result.refusal.code} ${result.refusal.details.join()}`);
  assertVerdictInvariants(target, project, result);
  return result;
}

export function text(files: readonly PlatformFile[], path: string): string {
  const content = files.find((file) => file.path === path)?.content;
  if (typeof content !== 'string') throw new Error(`${path} is not an emitted text file`);
  return content;
}

export function json(files: readonly PlatformFile[], path: string): Record<string, unknown> {
  return JSON.parse(text(files, path)) as Record<string, unknown>;
}

export function verdict(report: readonly FieldVerdict[], path: string) {
  return report.find((entry) => entry.path === path);
}
