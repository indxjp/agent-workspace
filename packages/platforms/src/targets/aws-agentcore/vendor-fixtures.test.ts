import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PlatformFile } from '@indx-workspace/contracts/platforms';
import { describe, expect, it } from 'vitest';

import { AgentCoreProjectSubsetSchema, HarnessSpecSubsetSchema } from './harness-spec.subset.js';
import { importAwsAgentCore } from './import.js';

// Verbatim copies of aws/agentcore-cli@dd6304e examples/AgentCoreCliReviewer (see the SOURCE.md
// beside them for the blob SHAs and the V1-V5 outcomes).
const ROOT = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'vendor-fixtures',
  'agentcore-cli-dd6304e',
  'AgentCoreCliReviewer',
);

const PROJECT = 'agentcore/agentcore.json';
const HARNESS = 'app/PRReviewer/harness.json';
const PROMPT = 'app/PRReviewer/system-prompt.md';

const files: PlatformFile[] = [PROJECT, HARNESS, PROMPT].map((path) => ({
  path,
  content: readFileSync(join(ROOT, path), 'utf8'),
}));

function text(path: string): string {
  const content = files.find((file) => file.path === path)?.content;
  if (typeof content !== 'string') throw new Error(`${path} is not a fixture`);
  return content;
}

describe('AgentCore CLI example AgentCoreCliReviewer (verbatim)', () => {
  it('matches the transcribed schema subset', () => {
    expect(() => AgentCoreProjectSubsetSchema.parse(JSON.parse(text(PROJECT)))).not.toThrow();
    expect(() => HarnessSpecSubsetSchema.parse(JSON.parse(text(HARNESS)))).not.toThrow();
  });

  it('imports into a portable project', () => {
    const result = importAwsAgentCore(files);
    if (!result.ok) throw new Error(result.refusal.code);
    const [root] = result.project.agents;
    expect(result.project.root).toBe('prreviewer');
    expect(root?.model).toEqual({ provider: 'anthropic', id: 'claude-opus-4-7' });
    expect(root?.instructions).toBe(text(PROMPT).replace(/\n$/u, ''));
    expect(root?.tools ?? []).toEqual([]);
    expect(result.report.find((verdict) => verdict.path === 'prreviewer.dockerfile')).toMatchObject(
      {
        verdict: 'dropped',
        code: 'field_unsupported',
      },
    );
  });
});
