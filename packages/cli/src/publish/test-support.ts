import { vi } from 'vitest';

import type { ToolInvocation, ToolResult, ToolRunner } from '../deploy/runner.ts';
import type { PublishContext, PublishPlatformId } from './kit.ts';

/** A fake process runner: records every call and answers from `answers`, keyed `tool first-argument`. */
export function fakeRunner(answers: Readonly<Record<string, Partial<ToolResult> | Error>>): {
  readonly runner: ToolRunner;
  readonly calls: ToolInvocation[];
} {
  const calls: ToolInvocation[] = [];
  const runner: ToolRunner = (invocation) => {
    calls.push(invocation);
    const answer = answers[`${invocation.tool} ${invocation.args[0] ?? ''}`];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ status: 0, stdout: '', stderr: '', ...answer });
  };
  return { runner, calls };
}

export function missingTool(): Error {
  return Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
}

export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A recording `fetch`: `respond` answers each call. */
export function fakeFetch(respond: (call: FetchCall) => Response): {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fake: typeof fetch = (input, init) => {
    const call: FetchCall = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { fetch: fake, calls };
}

export function testContext(
  runner: ToolRunner,
  overrides: Partial<PublishContext> & { readonly platform?: PublishPlatformId } = {},
): { readonly context: PublishContext; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: PublishContext = {
    platform: 'claude-managed-agents',
    runner,
    fetch: vi.fn<typeof fetch>(),
    directory: '/work/platforms/export',
    agent: 'support',
    env: { HOME: '/home/owner' },
    apply: false,
    experimental: false,
    environment: 'default',
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    conceal: () => undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
  return { context, stdout, stderr };
}
