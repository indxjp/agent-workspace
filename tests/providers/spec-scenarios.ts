import { readFile } from 'node:fs/promises';

import type { ProviderScenarioId } from './types.js';

export type ProviderScenarioInventory = {
  readonly required: readonly ProviderScenarioId[];
  readonly optional: readonly ProviderScenarioId[];
};

function slug(line: string): ProviderScenarioId {
  return line
    .replace(/^\s*[^\p{L}\p{N}]+/u, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-') as ProviderScenarioId;
}

function fencedBlocks(section: string): readonly string[] {
  return [...section.matchAll(/```text\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1] ?? '');
}

function lines(block: string): readonly ProviderScenarioId[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(slug);
}

export function readProviderScenarioInventory(spec: string): ProviderScenarioInventory {
  const section = spec.match(
    /^# 41\. Provider Compatibility Tests\r?\n([\s\S]*?)(?=^# 42\.)/m,
  )?.[1];
  if (section === undefined) {
    throw new Error('docs/spec.md is missing §41 Provider Compatibility Tests.');
  }

  const blocks = fencedBlocks(section);
  if (blocks.length < 2) {
    throw new Error('spec §41 must contain required and optional scenario fences.');
  }

  return { required: lines(blocks[0] ?? ''), optional: lines(blocks[1] ?? '') };
}

export async function readProviderScenarioInventoryFromSpec(
  path = new URL('../../docs/spec.md', import.meta.url),
): Promise<ProviderScenarioInventory> {
  return readProviderScenarioInventory(await readFile(path, 'utf8'));
}
