/**
 * Test Connection, driven end to end against real fixture MCP servers — the acceptance criterion
 * The Wave 2 plan states for this task: *"a wrong URL and a wrong token produce two
 * different human-readable errors."* Verified on `http` (and `sse`) below, over the real wire
 * protocol, not mocked.
 *
 * `stdio` is a separate story (ADR-0045, round 3): this control plane does not spawn a
 * caller-supplied command at all, sandboxed or not, so there is exactly one stdio outcome now — a
 * declared refusal — regardless of what the connector's command/args/env/credential say. The
 * `stdio` describe block below proves that refusal is unconditional and, twice over, that nothing
 * is actually executed to produce it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { restrictedBaseEnv } from './base-env';
import { testConnection } from './test-connection';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// `baseEnv` is a required argument (round 2, B1) — this is the same minimal, explicit
// environment a real route call site passes, so these tests exercise the actual production seam
// rather than a bespoke test-only shortcut.
const TEST_BASE_ENV = restrictedBaseEnv();

interface RunningHttpFixture {
  readonly port: number;
  stop(): void;
}

/** Spawn `fixtures/http-server.mjs` or `fixtures/sse-server.mjs`, and resolve once it has printed
 *  the port it bound. */
async function startHttpLikeFixture(
  script: string,
  env: Readonly<Record<string, string>>,
): Promise<RunningHttpFixture> {
  const child = spawn(process.execPath, [path.join(FIXTURES_DIR, script)], {
    env: { ...process.env, ...env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const match = /PORT=(\d+)/.exec(buffer);
      if (match?.[1] !== undefined) {
        child.stdout.off('data', onData);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`fixture ${script} exited early with code ${String(code)}`)),
    );
  });
  return {
    port,
    stop: (): void => {
      child.kill('SIGKILL');
    },
  };
}

const running: RunningHttpFixture[] = [];
afterEach(() => {
  for (const fixture of running.splice(0)) fixture.stop();
});

async function fixture(
  script: string,
  env: Readonly<Record<string, string>> = {},
): Promise<RunningHttpFixture> {
  const f = await startHttpLikeFixture(script, env);
  running.push(f);
  return f;
}

const STDIO_SCRIPT = path.join(FIXTURES_DIR, 'stdio-server.mjs');

describe('Test Connection — http', () => {
  it('succeeds with the correct token', async () => {
    const server = await fixture('http-server.mjs', { REQUIRE_TOKEN: 'right-token' });
    const result = await testConnection(
      {
        transport: 'http',
        url: `http://127.0.0.1:${String(server.port)}/mcp`,
        headers: { Authorization: 'Bearer right-token' },
        credentialConfigured: true,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('ok');
    if (result.ok) expect(result.toolCount).toBe(3);
  });

  it('a WRONG token produces credential-rejected', async () => {
    const server = await fixture('http-server.mjs', { REQUIRE_TOKEN: 'right-token' });
    const result = await testConnection(
      {
        transport: 'http',
        url: `http://127.0.0.1:${String(server.port)}/mcp`,
        headers: { Authorization: 'Bearer WRONG' },
        credentialConfigured: true,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('credential-rejected');
  });

  it('a WRONG URL (nothing listening) produces unreachable', async () => {
    // A high, unassigned port with nothing bound to it — refused at the TCP level (ECONNREFUSED),
    // unlike port 1, which undici's own `fetch` refuses outright as a "bad port" before any
    // socket is opened at all.
    const result = await testConnection(
      {
        transport: 'http',
        url: 'http://127.0.0.1:18291/mcp',
        headers: { Authorization: 'Bearer right-token' },
        credentialConfigured: true,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('unreachable');
  });

  it('THE ACCEPTANCE CRITERION: wrong URL and wrong token produce two different tags and two different sentences', async () => {
    const server = await fixture('http-server.mjs', { REQUIRE_TOKEN: 'right-token' });
    const wrongToken = await testConnection(
      {
        transport: 'http',
        url: `http://127.0.0.1:${String(server.port)}/mcp`,
        headers: { Authorization: 'Bearer WRONG' },
        credentialConfigured: true,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    const wrongUrl = await testConnection(
      {
        transport: 'http',
        url: 'http://127.0.0.1:18291/mcp',
        headers: { Authorization: 'Bearer right-token' },
        credentialConfigured: true,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    expect(wrongToken.ok).toBe(false);
    expect(wrongUrl.ok).toBe(false);
    expect(wrongToken.kind).not.toBe(wrongUrl.kind);
    if (!wrongToken.ok && !wrongUrl.ok) {
      expect(wrongToken.message).not.toBe(wrongUrl.message);
      // Printed so a human reader (and this task's PR body) can paste both verbatim.
      console.log(`[acceptance] wrong token -> ${wrongToken.kind}: ${wrongToken.message}`);
      console.log(`[acceptance] wrong url   -> ${wrongUrl.kind}: ${wrongUrl.message}`);
    }
  });

  it('no credential configured against a server that requires one is auth-required, not credential-rejected', async () => {
    const server = await fixture('http-server.mjs', { REQUIRE_TOKEN: 'right-token' });
    const result = await testConnection(
      {
        transport: 'http',
        url: `http://127.0.0.1:${String(server.port)}/mcp`,
        headers: {},
        credentialConfigured: false,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('auth-required');
  });
});

describe('Test Connection — sse', () => {
  it('succeeds with the correct token', async () => {
    const server = await fixture('sse-server.mjs', { REQUIRE_TOKEN: 'right-token' });
    const result = await testConnection(
      {
        transport: 'sse',
        url: `http://127.0.0.1:${String(server.port)}/sse`,
        headers: { Authorization: 'Bearer right-token' },
        credentialConfigured: true,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.toolCount).toBe(3);
  });

  it('a WRONG token produces credential-rejected', async () => {
    const server = await fixture('sse-server.mjs', { REQUIRE_TOKEN: 'right-token' });
    const result = await testConnection(
      {
        transport: 'sse',
        url: `http://127.0.0.1:${String(server.port)}/sse`,
        headers: { Authorization: 'Bearer WRONG' },
        credentialConfigured: true,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('credential-rejected');
  });

  it('a WRONG URL (nothing listening) produces unreachable', async () => {
    const result = await testConnection(
      {
        transport: 'sse',
        url: 'http://127.0.0.1:18291/sse',
        headers: {},
        credentialConfigured: false,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('unreachable');
  });
});

describe('Test Connection — stdio (ADR-0045: refused, never spawned)', () => {
  // Round 2 tried to make the stdio probe SAFE to run (a narrowed `baseEnv`). Round 3's finding
  // (B1) was that safety was never achievable this way — a spawned child inherits this process's
  // filesystem regardless of its environment, and can read this deployment's secrets straight off
  // disk (or, on the Linux containers this deploys to, out of `/proc/<ppid>/environ`) with no
  // environment variable involved at all. So ADR-0045 removes the spawn itself: these tests assert
  // `testConnection` never runs `STDIO_SCRIPT` (or any command) for a `stdio` config, no matter
  // what the config says, and instead always answers the same named, declared refusal.

  const STDIO_MARKER = 'w2-cp-05-round3-would-have-spawned';

  it('ATTACK: a command that writes a sentinel file the instant it starts never gets to write it', async () => {
    // The strongest available proof that nothing is spawned: not "the outcome looks like a
    // refusal", but "a side effect only a running child could produce did not happen". If this
    // ever regresses to spawning `config.command`, the sentinel file exists after the await below
    // — `node -e` writes it as the very first thing it does, before any MCP framing.
    const dir = mkdtempSync(path.join(tmpdir(), 'w2-cp-05-adr-0045-'));
    const sentinel = path.join(dir, 'ran.txt');
    try {
      const result = await testConnection(
        {
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'RAN')`],
          env: {},
          credentialConfigured: false,
        },
        { baseEnv: TEST_BASE_ENV },
      );
      expect(result.ok).toBe(false);
      expect(result.kind).toBe('stdio-probe-unavailable');
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never spawns the command: the real fixture MCP server (which would answer within milliseconds) never gets to', async () => {
    // A generous window: if this ever regresses to actually spawning STDIO_SCRIPT, the fixture
    // answers the real MCP handshake within milliseconds; returning this fast would not be
    // possible if the child had run and this probe had waited on it.
    const before = Date.now();
    const result = await testConnection(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_SCRIPT],
        env: { REQUIRE_TOKEN: STDIO_MARKER, MCP_TOKEN: STDIO_MARKER },
        credentialConfigured: true,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    const elapsed = Date.now() - before;
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('stdio-probe-unavailable');
    // Returned essentially instantly — no process was spawned, no MCP handshake was attempted, no
    // I/O was awaited. A real spawn-and-handshake (the pre-round-3 behaviour) takes tens of
    // milliseconds at minimum on every platform this suite runs on.
    expect(elapsed).toBeLessThan(200);
  });

  it('the refusal names the missing resource, regardless of whether the command could ever run at all', () => {
    // A config whose command is guaranteed to fail loudly if spawned (ENOENT) — proving the
    // refusal does not depend on the command being runnable, because it is never run. The message
    // MAY echo the caller's own submitted command text back to them (it is their own input, not
    // anything read from a process — no process ever started to read anything from); what it must
    // never do is what `process-died`'s message was fixed in round 2 to stop doing: repeat
    // anything a spawned CHILD wrote to its own stdout/stderr. There is no child here at all.
    return testConnection(
      {
        transport: 'stdio',
        command: 'w2cp05-no-such-binary-anywhere',
        args: [],
        env: {},
        credentialConfigured: false,
      },
      { baseEnv: TEST_BASE_ENV },
    ).then((result) => {
      expect(result.ok).toBe(false);
      expect(result.kind).toBe('stdio-probe-unavailable');
      if (!result.ok) {
        expect(result.message).toMatch(/sandboxed runner/i);
      }
    });
  });

  it('the outcome does not depend on the command, args, env or credential — it is the same refusal every time', async () => {
    const a = await testConnection(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_SCRIPT],
        env: { REQUIRE_TOKEN: 'right-token', MCP_TOKEN: 'right-token' },
        credentialConfigured: true,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    const b = await testConnection(
      {
        transport: 'stdio',
        command: 'anything-at-all',
        args: ['--whatever'],
        env: {},
        credentialConfigured: false,
      },
      { baseEnv: TEST_BASE_ENV },
    );
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(a.kind).toBe('stdio-probe-unavailable');
    expect(b.kind).toBe('stdio-probe-unavailable');
  });

  // NOTE on this task's acceptance criterion ("a wrong URL and a wrong token produce two
  // different human-readable errors"): stdio no longer has two distinguishable failure modes to
  // produce, by design — there is exactly one stdio outcome now, the refusal above. Spec §8's
  // Test Connection is not specified as stdio-only, and the criterion is verified end to end on
  // http (below, "THE ACCEPTANCE CRITERION") and was verified on sse in round 1/2. See ADR-0045
  // and this task's PR report, Declared gaps.
});

describe('Test Connection — timeout', () => {
  it('a server that never answers times out inside the given budget', async () => {
    // A raw TCP listener that accepts and never writes: no HTTP framing at all, so the client's
    // fetch just hangs waiting on headers until this probe's own deadline fires.
    const net = await import('node:net');
    const server = net.createServer(() => {
      /* accept and never write */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const started = Date.now();
      const result = await testConnection(
        {
          transport: 'http',
          url: `http://127.0.0.1:${String(port)}/mcp`,
          headers: {},
          credentialConfigured: false,
        },
        { timeoutMs: 800, baseEnv: TEST_BASE_ENV },
      );
      const elapsed = Date.now() - started;
      expect(result.ok).toBe(false);
      expect(result.kind).toBe('timeout');
      expect(elapsed).toBeGreaterThanOrEqual(750);
    } finally {
      server.close();
    }
  }, 10_000);
});
