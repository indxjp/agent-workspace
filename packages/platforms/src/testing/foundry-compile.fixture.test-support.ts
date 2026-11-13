import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FieldVerdict } from '@indx-workspace/contracts/platforms';
import {
  PortableProjectSchema,
  type PortableAgentInput,
  type PortableProject,
  type PortableProjectInput,
} from '@indx-workspace/contracts/portable-agent';
import { SAMPLE_PORTABLE_PROJECT, assertVerdictInvariants } from './index.js';

import { compileForPlatform } from '../compile.js';

import { microsoftFoundryTarget } from '../targets/microsoft-foundry/index.js';
import {
  FoundryAgentVersionBodySchema,
  FoundryPublishPlanSchema,
} from '../targets/microsoft-foundry/wire.js';

export const MODEL_OPTIONS = { modelDeployment: 'claude-sonnet-4-6' };
export const ROOT = 'support-triage';

export function golden(name: string): string {
  return fileURLToPath(new URL(`../targets/microsoft-foundry/__golden__/${name}`, import.meta.url));
}

export function goldenOptions(name: string): unknown {
  return JSON.parse(readFileSync(join(golden(name), 'options.json'), 'utf8'));
}

export function parse(input: PortableProjectInput): PortableProject {
  return PortableProjectSchema.parse(input);
}

/** The sample with `patch` applied to the root agent. */
export function sampleWith(
  patch: Partial<PortableAgentInput>,
  base: PortableProjectInput = SAMPLE_PORTABLE_PROJECT,
): PortableProject {
  return parse({
    ...base,
    agents: base.agents.map((agent) => (agent.name === ROOT ? { ...agent, ...patch } : agent)),
  });
}

export function compile(project: PortableProject, options: unknown = MODEL_OPTIONS) {
  const result = compileForPlatform(microsoftFoundryTarget, project, options);
  if (!result.ok)
    throw new Error(`refused: ${result.refusal.code} ${result.refusal.details.join()}`);
  assertVerdictInvariants(microsoftFoundryTarget, project, result);
  return result;
}

export function refusalOf(project: PortableProject, options: unknown = MODEL_OPTIONS) {
  const result = compileForPlatform(microsoftFoundryTarget, project, options);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

function fileText(result: ReturnType<typeof compile>, path: string): string {
  const file = result.files.find((candidate) => candidate.path === path);
  if (typeof file?.content !== 'string') throw new Error(`no text file ${path}`);
  return file.content;
}

export function versionOf(result: ReturnType<typeof compile>, agent = ROOT) {
  return FoundryAgentVersionBodySchema.parse(
    JSON.parse(fileText(result, `agents/${agent}.version.json`)),
  );
}

export function verdictAt(result: ReturnType<typeof compile>, path: string): FieldVerdict {
  const verdict = result.report.find((entry) => entry.path === path);
  if (verdict === undefined) throw new Error(`no verdict at ${path}`);
  return verdict;
}

export const sample = parse(SAMPLE_PORTABLE_PROJECT);

export function planOf(result: ReturnType<typeof compile>) {
  return FoundryPublishPlanSchema.parse(JSON.parse(fileText(result, 'project.plan.json')));
}
