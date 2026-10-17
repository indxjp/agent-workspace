import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

import {
  EXPECTED_STEP_COUNT,
  SpecFlowError,
  parsePrimaryFlow,
  readPrimaryFlow,
  runPrimaryFlow,
} from './flow.mjs';
import { includesDiscoveredModelConnection, streamHasSuccessfulToolExecution } from './adapter.mjs';

describe('Wave 8 primary E2E flow', () => {
  it('matches discovered models by connectionId rather than provider model id', () => {
    const response = {
      models: [
        {
          id: 'claude-sonnet-4-5-20250929',
          connectionId: 'model-connection-one',
        },
      ],
    };

    expect(includesDiscoveredModelConnection(response, 'model-connection-one')).toBe(true);
    expect(includesDiscoveredModelConnection(response, 'claude-sonnet-4-5-20250929')).toBe(false);
  });

  it('requires a completed tool exchange and rejects permission-denied attempts', () => {
    const toolUse = 'data: {"event":{"content":[{"type":"tool_use"}]}}\n\n';
    const toolResult = 'data: {"event":{"content":[{"type":"tool_result"}]}}\n\n';

    expect(streamHasSuccessfulToolExecution(toolUse + toolResult)).toBe(true);
    expect(
      streamHasSuccessfulToolExecution(
        toolUse + 'data: {"subtype":"permission_denied"}\n\n' + toolResult,
      ),
    ).toBe(false);
  });

  it('selects the End-to-End fence in §51 and derives exactly eleven ordered steps', async () => {
    const steps = await readPrimaryFlow();
    expect(steps).toHaveLength(EXPECTED_STEP_COUNT);
    expect(steps.at(0)).toBe('create user');
    expect(steps.at(-1)).toBe('resume session');
  });

  it.each([
    ['missing heading', '# 51. Testing\n```text\nwrong\n```', 'END_TO_END_HEADING_MISSING'],
    [
      'missing fence',
      '# 51. Testing\n### End-to-End\nNo block\n### Later',
      'END_TO_END_FENCE_MISSING',
    ],
    [
      'wrong count',
      '# 51. Testing\n### End-to-End\n```text\none\n↓\ntwo\n```',
      'END_TO_END_STEP_COUNT',
    ],
  ])('refuses a %s with a named error', (_label, source, code) => {
    expect(() => parsePrimaryFlow(source)).toThrow(SpecFlowError);
    expect(() => parsePrimaryFlow(source)).toThrow(code);
  });

  it('fails when a step runner is deleted', async () => {
    const steps = await readPrimaryFlow();
    const runners = Object.fromEntries(
      steps.map((step) => [step, () => ({ asserted: true, ok: true })]),
    );
    delete runners[steps[4]!];
    const results = await runPrimaryFlow({
      steps,
      runners,
      loginPath: 'bootstrap-administrator',
    });
    expect(results[4]?.status).toBe('failed');
  });

  it('fails when an assertion is removed and records the login path', async () => {
    const steps = await readPrimaryFlow();
    const runners = Object.fromEntries(
      steps.map((step) => [step, () => ({ asserted: true, ok: true })]),
    );
    runners[steps[2]!] = () => ({ asserted: false, ok: true });
    const results = await runPrimaryFlow({ steps, runners, loginPath: 'oidc' });
    expect(results[0]?.loginPath).toBe('oidc');
    expect(results[2]?.status).toBe('failed');
  });

  it('uses credential-bound only for a named gateway 401 on an eligible step', async () => {
    const steps = await readPrimaryFlow();
    const runners = Object.fromEntries(
      steps.map((step) => [step, () => ({ asserted: true, ok: true })]),
    );
    runners['run'] = () => ({
      asserted: true,
      ok: false,
      status: 401,
      code: 'token_missing',
      detail: 'gateway rejected the run token',
    });
    runners['create agent'] = () => ({
      asserted: true,
      ok: false,
      status: 401,
      code: 'token_missing',
    });
    const results = await runPrimaryFlow({
      steps,
      runners,
      loginPath: 'bootstrap-administrator',
    });
    expect(results.find((result) => result.id === 'run')?.status).toBe('credential-bound');
    expect(results.find((result) => result.id === 'create agent')?.status).toBe('failed');
  });

  it.each(['missing-step', 'missing-assertion'])(
    'exits non-zero when the fixed adapter has a %s',
    (fault) => {
      const run = spawnSync(process.execPath, ['tests/e2e/run-harness-selftest.mjs'], {
        cwd: new URL('../../', import.meta.url),
        encoding: 'utf8',
        env: {
          ...process.env,
          E2E_TEST_FAULT: fault,
        },
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    },
  );
});
