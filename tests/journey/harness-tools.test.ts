import { failureOf, record, NONCE, AGENT_SOURCE } from './harness-fixtures.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SEALED_PATHS,
  assertSecretAbsent,
  assertServerRefusal,
  assertToolAnswer,
  assertToolCallSeen,
  assertToolOffered,
  assertUnchanged,
  filesContaining,
} from './harness.mjs';

describe('S2-08: the tool call', () => {
  const TOKEN = 'orders-e2e-0123456789abcdef';
  function call(authorization: string | null, route = `/orders/${NONCE}`) {
    return { method: 'GET', path: route, authorization };
  }

  it('passes when the orders API saw GET /orders/<nonce> with the token', () => {
    expect(() => assertToolCallSeen([call(`Bearer ${TOKEN}`)], NONCE, TOKEN)).not.toThrow();
  });

  it('fails on no call, on the wrong path, and on a wrong or missing token, naming neither token', () => {
    expect(failureOf(() => assertToolCallSeen([], NONCE, TOKEN)).message).toBe(
      `the orders API never saw GET /orders/${NONCE}`,
    );
    expect(
      failureOf(() => assertToolCallSeen([call(`Bearer ${TOKEN}`, '/orders/other')], NONCE, TOKEN))
        .message,
    ).toBe(`the orders API never saw GET /orders/${NONCE}`);
    for (const authorization of ['Bearer orders-e2e-wrong', null, TOKEN]) {
      const failure = failureOf(() => assertToolCallSeen([call(authorization)], NONCE, TOKEN));
      expect(failure.message).toBe(
        `the orders API saw GET /orders/${NONCE}, but never with the token`,
      );
      expect(failure.message).not.toContain(TOKEN);
      expect(failure.message).not.toContain('orders-e2e-wrong');
    }
  });

  it("fails when the answer lacks the tool's data", () => {
    const withData = record({
      reply: `Fake Anthropic reply to ${NONCE}: {"note":"order-data-${NONCE}"}`,
    });
    expect(() => assertToolAnswer([withData], NONCE)).not.toThrow();
    expect(failureOf(() => assertToolAnswer([record({})], NONCE)).message).toBe(
      `the fake provider answered ${NONCE} without the tool's data (order-data-${NONCE})`,
    );
    expect(failureOf(() => assertToolAnswer([], NONCE)).message).toBe(
      `the fake provider never answered ${NONCE}`,
    );
  });
});

describe('S2-08: Bash offered before the ceiling, denied under it', () => {
  const ORDERS = 'mcp__orders__getOrderByOrderNumber';
  function turn(toolNames: string[], nonce: string | null = NONCE) {
    return { nonce, toolNames };
  }

  it('passes the baseline with Bash and the ceiling run without it', () => {
    expect(() => assertToolOffered([turn(['Bash', ORDERS])], NONCE, 'Bash', true)).not.toThrow();
    expect(() => assertToolOffered([turn(['Read', ORDERS])], NONCE, 'Bash', false)).not.toThrow();
  });

  it('fails when Bash is offered under the ceiling', () => {
    expect(
      failureOf(() => assertToolOffered([turn(['Bash', ORDERS])], NONCE, 'Bash', false)).message,
    ).toBe(`Bash was offered to the model for ${NONCE} under the ceiling`);
  });

  it('fails when the baseline does not offer Bash, so the denial would prove nothing', () => {
    expect(failureOf(() => assertToolOffered([turn([ORDERS])], NONCE, 'Bash', true)).message).toBe(
      `Bash was not offered to the model for ${NONCE}, so its denial would prove nothing`,
    );
  });

  it('fails when no agent turn for the nonce offered the orders tool', () => {
    const turns = [turn([]), turn(['Bash', ORDERS], 'e2e-nonce-other')];
    expect(failureOf(() => assertToolOffered(turns, NONCE, 'Bash', false)).message).toBe(
      `no model request for ${NONCE} offered the orders tool`,
    );
  });
});

describe('S2-08: the ceiling refusal comes from the server', () => {
  const FILE = 'agents/assistant.ts';
  const LINE = `${FILE}: 403 policy_cannot_widen [permissions.runCommands]`;

  it('passes on the 403 line, with or without a hint', () => {
    expect(() => assertServerRefusal(`checking\n${LINE}\r\n`, FILE)).not.toThrow();
    expect(() => assertServerRefusal(`${LINE}; ask an admin`, FILE)).not.toThrow();
  });

  it('fails on the local form: computed without the server', () => {
    expect(
      failureOf(() =>
        assertServerRefusal(`${FILE}: local policy_cannot_widen [permissions.runCommands]`, FILE),
      ).message,
    ).toBe(`policy_cannot_widen for ${FILE} was computed without the server`);
  });

  it('fails when the line is absent, or names another detail', () => {
    const expected = `no "${LINE}" line`;
    expect(
      failureOf(() => assertServerRefusal('synced: "assistant" unchanged', FILE)).message,
    ).toBe(expected);
    expect(
      failureOf(() =>
        assertServerRefusal(
          `${FILE}: 403 policy_cannot_widen [permissions.runCommands, engine]`,
          FILE,
        ),
      ).message,
    ).toBe(expected);
  });
});

describe('S2-08: the token is absent', () => {
  const TOKEN = 'orders-e2e-feedfacecafebeef';
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function write(root: string, relative: string, contents: string): void {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), contents);
  }

  it('finds the token in a file and a transcript, but not in the sealed store or node_modules', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'journey-secret-'));
    directories.push(root);
    expect(SEALED_PATHS).toEqual(['node_modules/', '.agent-workspace/postgres/']);
    write(root, 'agents/assistant.ts', AGENT_SOURCE);
    write(root, '.env', `ORDERS_TOKEN=${TOKEN}\n`);
    write(root, '.agent-workspace/storage/sessions/x', `{"text":"${TOKEN}"}`);
    write(root, '.agent-workspace/postgres/base/1', `sealed ${TOKEN}`);
    write(root, 'node_modules/pkg/index.js', TOKEN);
    expect(filesContaining(root, TOKEN)).toEqual(['.agent-workspace/storage/sessions/x', '.env']);
    expect(failureOf(() => filesContaining(root, '')).message).toBe(
      'the secret check was given no secret',
    );
  });

  it('names the place holding the token, never the token', () => {
    expect(() =>
      assertSecretAbsent({ 'dev-1.log': 'ready', environ: 'PATH=/bin' }, TOKEN),
    ).not.toThrow();
    const failure = failureOf(() =>
      assertSecretAbsent(
        { 'dev-1.log': `token ${TOKEN}`, environ: `ORDERS_TOKEN=${TOKEN}`, other: 'x' },
        TOKEN,
      ),
    );
    expect(failure.message).toBe('the token appears in: dev-1.log, environ');
    expect(failure.message).not.toContain(TOKEN);
  });
});

describe('S2-08: no file setup wrote is edited', () => {
  const before = { 'tools/orders.ts': 'aa', 'agents/assistant.ts': 'bb' };
  const input = 'apis/orders.openapi.json';

  it("allows the developer's document to be added", () => {
    expect(() =>
      assertUnchanged('demo-tools', before, { ...before, [input]: 'cc' }, [input]),
    ).not.toThrow();
  });

  it('still fails on a changed generated file, and on any other added file', () => {
    const edited = { ...before, [input]: 'cc', 'tools/orders.ts': 'ff' };
    expect(failureOf(() => assertUnchanged('demo-tools', before, edited, [input])).message).toBe(
      'demo-tools/ changed after init:\n  changed: tools/orders.ts',
    );
    const extra = { ...before, [input]: 'cc', 'tools/extra.ts': 'dd' };
    expect(failureOf(() => assertUnchanged('demo-tools', before, extra, [input])).message).toBe(
      'demo-tools/ changed after init:\n  added: tools/extra.ts',
    );
  });
});
