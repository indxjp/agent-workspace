/**
 * The real pi coding agent, run through this adapter against a fake gateway (ENG-08, #307).
 *
 * The conformance kit drives the adapter with replayed events; this suite drives **pi** —
 * `createAgentSession`, its Anthropic client, its built-in tools, its `SessionManager` — against an
 * HTTP server that answers in the Anthropic Messages dialect. The fixtures are hand-authored from
 * the published event schema; no live credential is used. What the suite proves is the adapter's
 * half of each acceptance criterion:
 *
 *  * a run that reads and writes a file streams `agent.message.delta`, `agent.tool.call` /
 *    `agent.tool.result` and `agent.result {stopReason: 'end_turn'}`;
 *  * every request goes to the gateway with `Authorization: Bearer <run token>`; the `x-api-key`
 *    pi insists on is the public placeholder, even with a real-looking `ANTHROPIC_API_KEY` and an
 *    `ANTHROPIC_BASE_URL` in the runner's environment;
 *  * a write to a read-only grant — named directly, through `..` or through a symbolic link — is
 *    blocked as `agent.tool.result {status: 'failed'}` and the file is unchanged;
 *  * with `runCommands: false` the request's `tools` has no `bash`, and a `bash` call is blocked;
 *  * nothing under `~/.pi`, `~/.agents` or the project's own discovery paths is loaded, while the
 *    platform's placed skill is;
 *  * `bash` runs with the request's environment, never the runner's;
 *  * a second run on the session sends the first run's messages; a fork does too, under a new id;
 *  * `maxTurns` ends a looping agent `max_turns` (a spent `maxBudgetUsd` stops nothing here: the
 *    gateway enforces it, ADR-0162), and an interrupt during `bash` ends the run `cancelled`
 *    promptly.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PI_GATEWAY_API_KEY_PLACEHOLDER } from './compile.js';
import {
  type Recorded,
  TOKEN,
  result,
  run,
  systemText,
  toolNames,
  useFakeGateways,
} from './boundary.test-support.js';

const g = useFakeGateways();

describe('pi through the adapter: frames and the run token', () => {
  it('reads and writes a file, streaming the neutral frames, on the run token alone', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-a-real-looking-key-in-the-runner');
    vi.stubEnv('ANTHROPIC_BASE_URL', g.decoy.baseUrl);
    g.decoy.script([]);
    const cwd = g.workspace();
    writeFileSync(path.join(cwd, 'a.md'), 'the source document');
    g.gateway.script([
      { call: { name: 'read', args: { path: 'a.md' } } },
      { call: { name: 'write', args: { path: 'b.md', content: 'the copy' } } },
      { text: 'Copied.' },
    ]);

    const frames = await run(g.baseRequest(cwd));

    expect(readFileSync(path.join(cwd, 'b.md'), 'utf8')).toBe('the copy');
    const names = frames.map((frame) => frame.frame);
    expect(names[0]).toBe('agent.session');
    expect(names).toContain('agent.message.delta');
    expect(frames.filter((frame) => frame.frame === 'agent.tool.call')).toHaveLength(2);
    const results = frames.filter((frame) => frame.frame === 'agent.tool.result');
    expect(results.map((frame) => frame.frame === 'agent.tool.result' && frame.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(result(frames)).toMatchObject({ stopReason: 'end_turn', turns: 3 });
    expect(frames.every((frame) => frame.engine === 'pi')).toBe(true);

    expect(g.gateway.requests).toHaveLength(3);
    for (const recorded of g.gateway.requests) {
      expect(recorded.path).toBe('/v1/messages');
      expect(recorded.authorization).toBe(`Bearer ${TOKEN}`);
      expect(recorded.apiKeyHeader).toBe(PI_GATEWAY_API_KEY_PLACEHOLDER);
      expect(systemText(recorded)).toContain('PLATFORM INSTRUCTIONS: be terse.');
    }
    expect(g.decoy.requests).toHaveLength(0);
    expect(toolNames(g.gateway.requests[0] as Recorded).sort()).toEqual([
      'bash',
      'edit',
      'read',
      'write',
    ]);
  });
});

describe('pi through the adapter: provider refusals', () => {
  it.each([401, 403] as const)(
    'fails fast and clearly when the provider answers %i, after one request',
    async (status) => {
      g.gateway.script([{ refuse: { status } }]);

      const failure = await run(g.baseRequest(g.workspace())).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({
        message: `model_credential_rejected: the model provider rejected the API key (HTTP ${String(status)}).`,
      });
      expect(g.gateway.requests).toHaveLength(1);
    },
  );

  it("leaves the gateway's own token refusal as the plain model-call failure", async () => {
    g.gateway.script([{ refuse: { status: 401, code: 'token_expired' } }]);

    const failure = await run(g.baseRequest(g.workspace())).then(
      () => null,
      (error: unknown) => error,
    );

    expect(String(failure)).toContain("pi's model call failed");
    expect(String(failure)).not.toContain('model_credential_rejected');
  });
});

describe('pi through the adapter: permissions', () => {
  it('blocks a write to a read-only grant — directly, through .. and through a link', async () => {
    const cwd = g.workspace();
    writeFileSync(path.join(cwd, 'locked.md'), 'original');
    mkdirSync(path.join(cwd, 'notes'));
    symlinkSync('../locked.md', path.join(cwd, 'notes', 'alias.md'));
    g.gateway.script([
      { call: { name: 'write', args: { path: 'locked.md', content: 'changed' } } },
      {
        call: {
          name: 'edit',
          args: {
            path: 'notes/../locked.md',
            edits: [{ oldText: 'original', newText: 'changed' }],
          },
        },
      },
      { call: { name: 'write', args: { path: 'notes/alias.md', content: 'changed' } } },
      { call: { name: 'write', args: { path: '../outside.md', content: 'escaped' } } },
      { text: 'Could not.' },
    ]);

    const frames = await run(
      g.baseRequest(cwd, {
        resources: { files: [{ kind: 'file', path: 'locked.md', access: 'read' }], skills: [] },
      }),
    );

    expect(readFileSync(path.join(cwd, 'locked.md'), 'utf8')).toBe('original');
    expect(existsSync(path.join(g.root, 'outside.md'))).toBe(false);
    const results = frames.filter((frame) => frame.frame === 'agent.tool.result');
    expect(results).toHaveLength(4);
    for (const frame of results) {
      expect(frame).toMatchObject({ status: 'failed', isError: true });
    }
    // A read-only grant withholds bash: a redirect would write the file the grant protects.
    expect(toolNames(g.gateway.requests[0] as Recorded)).not.toContain('bash');
  });

  it('offers no bash with runCommands off, and blocks a bash call the model invents', async () => {
    const cwd = g.workspace();
    g.gateway.script([
      { call: { name: 'bash', args: { command: 'touch ran.txt' } } },
      { text: 'ok' },
    ]);
    const request = g.baseRequest(cwd);
    const frames = await run({
      ...request,
      portable: {
        ...request.portable,
        permissions: { ...request.portable.permissions, runCommands: false },
      },
    });
    expect(toolNames(g.gateway.requests[0] as Recorded)).not.toContain('bash');
    expect(existsSync(path.join(cwd, 'ran.txt'))).toBe(false);
    const toolResults = frames.filter((frame) => frame.frame === 'agent.tool.result');
    for (const frame of toolResults) expect(frame).toMatchObject({ status: 'failed' });
  });
});
