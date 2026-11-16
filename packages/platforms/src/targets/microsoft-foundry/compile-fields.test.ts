import { describe, expect, it } from 'vitest';

import {
  ROOT,
  compile,
  versionOf,
  verdictAt,
  sample,
} from '../../testing/foundry-compile.fixture.test-support.js';

const report = compile(sample).report;
const sampleVerdictAt = (path: string) => report.find((entry) => entry.path === path);

describe('Foundry agent fields', () => {
  it('maps description, instructions and the model', () => {
    expect(sampleVerdictAt(`${ROOT}.description`)?.verdict).toBe('native');
    expect(sampleVerdictAt(`${ROOT}.instructions`)?.verdict).toBe('native');
    expect(sampleVerdictAt(`${ROOT}.model`)?.verdict).toBe('mapped');
    const body = versionOf(compile(sample));
    expect(body.description).toBe('Triages customer support tickets and drafts replies.');
    expect(body.definition.model).toBe('claude-sonnet-4-6');
    expect(body.metadata).toEqual({
      'aw.apiVersion': 'agentworkspace.dev/v1',
      'aw.model': 'anthropic/claude-sonnet-4-6',
    });
  });

  it('notes the assumed deployment when none is named', () => {
    const result = compile(sample, {});
    expect(verdictAt(result, `${ROOT}.model`).note).toContain('modelDeployment');
  });

  it('maps a false permission and drops a true one', () => {
    expect(sampleVerdictAt(`${ROOT}.permissions.readFiles`)).toMatchObject({
      verdict: 'dropped',
      code: 'permissions_unsupported',
    });
    for (const key of ['writeFiles', 'runCommands', 'unrestrictedNetwork']) {
      expect(sampleVerdictAt(`${ROOT}.permissions.${key}`)?.verdict).toBe('mapped');
    }
  });
});
