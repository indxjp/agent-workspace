/**
 * The route-table gate this task's Accept criterion names: the served paths equal §14.3's five
 * plus the two AgentCore aliases, **read out of `docs/spec.md`'s §14.3 fenced block and its alias
 * table rather than transcribed** — and the status each one answers. W3-CP-07 makes both
 * `/files` directions implemented and this gate now pins the empty 501 set.
 *
 * Two things are compared, and they are different kinds of thing:
 *
 *   1. **The declared route set.** `parseSpecRoutes()` parses §14.3's ` ```text ` fenced block
 *      (five lines) and **every row of the alias table**, not one row read out by name, out of
 *      `docs/spec.md` at test time — never a hand-typed list (W3-RT-01's round-1 lesson: a
 *      hard-coded comparison list is exactly the thing that goes stale). `parseAliasTableRoutes`
 *      finds the table by its header, walks every body row, and classifies each one as either
 *      "carries concrete backtick-quoted `METHOD /path` tokens" (extracted and added to the set)
 *      or "one of the two known prose rows that name no route of their own" (`Azure Container
 *      Apps sessions` = "any path", `Kubernetes / Docker / ECS` = "our own paths") — a row it
 *      cannot place in either bucket throws naming the row, rather than being silently skipped
 *      (ADR-0015 / ADR-0031). Reading only the AgentCore row by name — the shape this replaced —
 *      fails **both ways**: a fourth row naming routes nobody wired in is silently accepted, and
 *      a correctly-added alias row is refused because the row that carries it was never read. The
 *      result is compared against `./http-contract.ts`'s `RUNTIME_HTTP_CONTRACT` **in both
 *      directions**: a route the spec declares and the contract lacks fails, and so does a route
 *      the contract declares and the spec does not (ADR-0015 — positive assertion, not the
 *      absence of a negative).
 *   2. **Which of those seven are 501 in this build.** That split is not something §14.3 states —
 *      W3-CP-07 has now flipped that fixed set to empty, in the same diff that supplies the real
 *      hydration and collection handlers.
 *
 * The second half of the criterion — "and the status each one answers" — is proved by **looping
 * `RUNTIME_HTTP_CONTRACT` itself** and issuing each entry's own method at its own path against the
 * real, running server (`createRunnerServer`), asserting `not_implemented` entries answer 501 by
 * name and `implemented` entries answer anything but 404 or 501 — plus a wrong-method probe per
 * entry, for the direction that path does not itself declare, asserting 405. A route that is
 * merely present in the data table but never wired into the dispatcher (declared `implemented`,
 * answers 404) passed the fixed seven-`it()` version of this section that shipped in round 1 —
 * nothing in it looped over the table — and fails this one.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { toAgentFrames } from '@agent-workspace/core';
import type { EngineFrame } from '@agent-workspace/engine';

import { installedEngines } from './engines.js';
import { RUNTIME_HTTP_CONTRACT, type ContractRoute } from './http-contract.js';
import { createRunnerServer } from './server.js';
import type { RunnerAgentConnection } from './runtime.js';

// `/healthz` lists the installed engines, so the first request imports every adapter package (four
// agent SDKs, seconds on a loaded CI runner). That import is paid once here, outside any test's own
// budget; the adapters are cached for the rest of the file.
beforeAll(async () => {
  await installedEngines();
}, 60_000);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs/spec.md');

// --- parsing docs/spec.md §14.3 --------------------------------------------------------------

type RouteKey = { readonly method: 'GET' | 'POST'; readonly path: string };

/** Extract the markdown section under a heading (matched by prefix) up to the next heading. */
function extractSection(markdown: string, headingPrefix: string): string {
  const lines = markdown.split('\n');
  const startIndex = lines.findIndex((line) => line.trimEnd().startsWith(headingPrefix));
  if (startIndex === -1) {
    throw new Error(`docs/spec.md has no heading starting with ${JSON.stringify(headingPrefix)}.`);
  }
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  const sectionLines = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return sectionLines.join('\n');
}

/**
 * §14.3's own ` ```text ` block: five lines shaped `METHOD /path   description`. Every non-blank
 * line inside the block must parse as that shape or this throws naming the line — a check that
 * cannot run must fail (ADR-0015), not skip the line and quietly return fewer routes than the
 * block actually has.
 */
function parseFencedTextRoutes(section: string): readonly RouteKey[] {
  const match = /```text\r?\n([\s\S]*?)```/.exec(section);
  if (match === null) {
    throw new Error('No ```text fenced block found under §14.3.');
  }
  const body = match[1] ?? '';
  const lines = body.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("§14.3's ```text fenced block is empty — nothing to parse.");
  }
  return lines.map((line) => {
    const routeMatch = /^(GET|POST)\s+(\/\S+)/.exec(line);
    if (routeMatch === null) {
      throw new Error(
        `§14.3 fenced-block line does not parse as "METHOD /path …": ${JSON.stringify(line)}`,
      );
    }
    const method = routeMatch[1];
    const routePath = routeMatch[2];
    if (method !== 'GET' && method !== 'POST') {
      throw new Error(`unreachable: regex only matches GET or POST (got ${method})`);
    }
    if (routePath === undefined) {
      throw new Error(`unreachable: regex requires a path capture (line ${JSON.stringify(line)})`);
    }
    return { method, path: routePath };
  });
}

/**
 * The two rows of §14.3's alias table that name no concrete route of their own — pass-through
 * rows for a platform that forwards to "our own paths" or "any path" rather than requiring one
 * specific to itself. A row's Target column must match one of these AND its requirement text must
 * still contain the named phrase, or it falls through to the `else` below (B1's repair: a row
 * this table gains that is neither this nor a row with backtick-quoted tokens must be refused,
 * not silently treated as one of these two by name alone).
 */
const PROSE_ALIAS_ROWS: readonly { readonly target: string; readonly mustContain: string }[] = [
  { target: 'Azure Container Apps sessions', mustContain: 'any path' },
  { target: 'Kubernetes / Docker / ECS', mustContain: 'our own paths' },
];

/**
 * §14.3's alias table, **every body row**, not one row picked out by searching for a name. Finds
 * the table by its own header (`| Target | Required by the platform |`), then walks each row
 * beneath the `---` separator until the table ends. Each row is classified by its own content,
 * never by which platform it names:
 *
 *   - a row whose requirement cell carries one or more backtick-quoted `METHOD /path` tokens
 *     contributes every one of those tokens as a route this server must serve (not a fixed pair —
 *     a row with three aliases contributes three);
 *   - a row matching one of the two {@link PROSE_ALIAS_ROWS} contributes nothing, by design; and
 *   - **anything else throws, naming the row and its line number** (ADR-0015 / ADR-0031) — a row
 *     this classifier cannot place in either bucket is a row a human added and the gate never
 *     learned about, and the failure mode this replaces is exactly that row sailing through
 *     silently because the old parser only ever looked at the one line matching `AgentCore`.
 */
function parseAliasTableRoutes(section: string): readonly RouteKey[] {
  const lines = section.split('\n');
  const headerIndex = lines.findIndex((line) =>
    /^\|\s*Target\s*\|\s*Required by the platform\s*\|/.test(line.trim()),
  );
  if (headerIndex === -1) {
    throw new Error(
      'No "| Target | Required by the platform |" alias-table header found under §14.3.',
    );
  }
  const bodyStart = headerIndex + 2; // header line, then the `| --- | --- |` separator line
  const routes: RouteKey[] = [];
  for (let i = bodyStart; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) break; // the table ended
    const cells = trimmed.split('|').slice(1, -1);
    const target = (cells[0] ?? '').trim();
    const requirement = (cells[1] ?? '').trim();

    const tokens = [...requirement.matchAll(/`(GET|POST)\s+(\/[A-Za-z0-9_-]+)`/g)];
    if (tokens.length > 0) {
      for (const token of tokens) {
        const method = token[1];
        const routePath = token[2];
        if (method !== 'GET' && method !== 'POST') {
          throw new Error(`unreachable: regex only matches GET or POST (got ${String(method)})`);
        }
        if (routePath === undefined) {
          throw new Error(`unreachable: regex requires a path capture (alias-table line ${i + 1})`);
        }
        routes.push({ method, path: routePath });
      }
      continue;
    }

    const known = PROSE_ALIAS_ROWS.find((row) => row.target === target);
    if (known !== undefined && requirement.includes(known.mustContain)) {
      continue; // a known prose row that declares no route of its own — not a defect, not a route
    }

    throw new Error(
      `§14.3 alias-table row ${i + 1} (target ${JSON.stringify(target)}) is neither a row ` +
        `carrying a backtick-quoted "METHOD /path" token nor one of the two known prose rows: ` +
        `${JSON.stringify(trimmed)}`,
    );
  }
  if (routes.length === 0) {
    throw new Error('§14.3 alias table produced zero concrete routes — nothing to parse.');
  }
  return routes;
}

function routeKeyText(route: RouteKey): string {
  return `${route.method} ${route.path}`;
}

/** §14.3's five endpoints plus the AgentCore aliases, parsed out of `docs/spec.md` right now. */
function parseSpecRoutes(specText: string): readonly RouteKey[] {
  const section = extractSection(specText, '## 14.3 The runtime container contract');
  return [...parseFencedTextRoutes(section), ...parseAliasTableRoutes(section)];
}

// --- comparing the parsed spec set against ./http-contract.ts's declared set ------------------

function diffRouteSets(
  specRoutes: readonly RouteKey[],
  contractRoutes: readonly ContractRoute[],
): readonly string[] {
  const specKeys = new Set(specRoutes.map(routeKeyText));
  const contractKeys = new Set(contractRoutes.map(routeKeyText));
  const diffs: string[] = [];
  for (const key of specKeys) {
    if (!contractKeys.has(key)) {
      diffs.push(`${key}: declared by docs/spec.md §14.3 but missing from RUNTIME_HTTP_CONTRACT`);
    }
  }
  for (const key of contractKeys) {
    if (!specKeys.has(key)) {
      diffs.push(`${key}: declared in RUNTIME_HTTP_CONTRACT but not found in docs/spec.md §14.3`);
    }
  }
  return diffs;
}

const specText = readFileSync(SPEC_PATH, 'utf8');
const specRoutes = parseSpecRoutes(specText);

describe("the declared route set equals docs/spec.md §14.3's five endpoints plus its two AgentCore aliases", () => {
  it('parses to exactly seven routes from the spec text', () => {
    expect(specRoutes.map(routeKeyText).sort()).toEqual(
      [
        'GET /healthz',
        'POST /run',
        'POST /interrupt',
        'POST /files',
        'GET /files',
        'POST /invocations',
        'GET /ping',
      ].sort(),
    );
  });

  it('RUNTIME_HTTP_CONTRACT matches that parsed set exactly, in both directions', () => {
    const diffs = diffRouteSets(specRoutes, RUNTIME_HTTP_CONTRACT);
    expect(diffs).toEqual([]);
  });
});

describe('all declared runtime routes are now implemented', () => {
  it('the not_implemented set is empty', () => {
    const notImplemented = RUNTIME_HTTP_CONTRACT.filter(
      (route) => route.status === 'not_implemented',
    );
    expect(notImplemented.map(routeKeyText).sort()).toEqual([]);
  });

  it('every other declared route is implemented', () => {
    const implemented = RUNTIME_HTTP_CONTRACT.filter((route) => route.status === 'implemented');
    expect(implemented.map(routeKeyText).sort()).toEqual(
      [
        'GET /files',
        'GET /healthz',
        'GET /ping',
        'POST /files',
        'POST /interrupt',
        'POST /invocations',
        'POST /run',
      ].sort(),
    );
  });
});

// --- proof the parser fails closed rather than silently under-counting (ADR-0015 / ADR-0029) --

describe('proof: the fenced-block parser refuses a line it cannot read, rather than skipping it', () => {
  it('throws naming the unparsable line', () => {
    const section = [
      '```text',
      'GET  /healthz            liveness / readiness',
      'this line names no method and no path',
      '```',
    ].join('\n');
    expect(() => parseFencedTextRoutes(section)).toThrowError(
      /fenced-block line does not parse as "METHOD \/path/,
    );
  });

  it('throws when the block is missing entirely', () => {
    expect(() => parseFencedTextRoutes('no fenced block here')).toThrowError(
      /No ```text fenced block found/,
    );
  });
});

describe('proof: the alias-table parser reads every row, not one row picked out by name', () => {
  it('throws when the table header itself is missing', () => {
    expect(() => parseAliasTableRoutes('no alias table here')).toThrowError(
      /No "\| Target \| Required by the platform \|" alias-table header/,
    );
  });

  it('throws naming the row when a row is neither concrete-token nor a known prose row', () => {
    const section = [
      '| Target | Required by the platform |',
      '| --- | --- |',
      '| Some Other Platform | some invocation path, unquoted |',
    ].join('\n');
    expect(() => parseAliasTableRoutes(section)).toThrowError(
      /alias-table row 3 \(target "Some Other Platform"\) is neither/,
    );
  });

  it('picks up every backtick-quoted token in a row, not a fixed pair', () => {
    const section = [
      '| Target | Required by the platform |',
      '| --- | --- |',
      '| Three-Path Platform | `POST /a`, `GET /b` and `POST /c` on port `8080` |',
    ].join('\n');
    expect(parseAliasTableRoutes(section).map(routeKeyText).sort()).toEqual(
      ['GET /b', 'POST /a', 'POST /c'].sort(),
    );
  });

  it(
    'a row is picked up by its own content, not by which platform it names — a row naming ' +
      '"AgentCore" a second time with different paths is read too, not shadowed by the first',
    () => {
      const section = [
        '| Target | Required by the platform |',
        '| --- | --- |',
        '| Amazon Bedrock AgentCore | `POST /invocations` and `GET /ping` on port `8080` |',
        '| Amazon Bedrock AgentCore v2 | `POST /invocations2` on port `8080` |',
      ].join('\n');
      expect(parseAliasTableRoutes(section).map(routeKeyText).sort()).toEqual(
        ['GET /ping', 'POST /invocations', 'POST /invocations2'].sort(),
      );
    },
  );

  it('the two known prose rows contribute no route of their own', () => {
    const section = [
      '| Target | Required by the platform |',
      '| --- | --- |',
      '| Azure Container Apps sessions | any path; the pool forwards the path to the target port |',
      '| Kubernetes / Docker / ECS | our own paths on port `8080` |',
    ].join('\n');
    expect(() => parseAliasTableRoutes(section)).toThrowError(/produced zero concrete routes/);
  });
});

describe('proof: a route set comparison names what is missing, in each direction', () => {
  it('names a route the spec has and the contract lacks', () => {
    const diffs = diffRouteSets(
      [
        { method: 'GET', path: '/healthz' },
        { method: 'POST', path: '/extra-in-spec' },
      ],
      [{ method: 'GET', path: '/healthz', status: 'implemented' }],
    );
    expect(diffs).toEqual([
      'POST /extra-in-spec: declared by docs/spec.md §14.3 but missing from RUNTIME_HTTP_CONTRACT',
    ]);
  });

  it('names a route the contract has and the spec lacks', () => {
    const diffs = diffRouteSets(
      [{ method: 'GET', path: '/healthz' }],
      [
        { method: 'GET', path: '/healthz', status: 'implemented' },
        { method: 'POST', path: '/extra-in-contract', status: 'implemented' },
      ],
    );
    expect(diffs).toEqual([
      'POST /extra-in-contract: declared in RUNTIME_HTTP_CONTRACT but not found in docs/spec.md §14.3',
    ]);
  });
});

// --- "and the status each one answers": issued against the real, running server ---------------

/** A `RunRequest` known to satisfy the real schema (mirrors `server.test.ts`'s fixture body). */
function runRequestBody(runId: string, sessionId: string): unknown {
  return {
    runId,
    sessionId,
    cwd: '/tmp/aw-http-contract-test',
    prompt: 'irrelevant — startAgent is replaced',
    projectKey: 'http-contract-test',
    portable: {
      name: 'General',
      instructions: '',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: 1, maxBudgetUsd: null },
    },
    policy: { tools: null, fileGrantDeny: [] },
    session: { kind: 'fresh', sessionId },
    env: {},
  };
}

/** A connection that yields one event and ends. */
function fakeConnection(): RunnerAgentConnection {
  return {
    frames: (async function* (): AsyncGenerator<EngineFrame> {
      await Promise.resolve();
      yield* toAgentFrames({ kind: 'malformed', reason: 'fixture event', event: {} });
    })(),
    sessionId: Promise.resolve('99999999-9999-4999-8999-999999999999'),
    interrupt: (): Promise<void> => Promise.resolve(),
    sessionDurability: () => ({ durable: false, reason: 'test fixture' }),
    engineVersion: '0.0.0-test',
  };
}

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createRunnerServer({
    startAgent: () => Promise.resolve({ ok: true, connection: fakeConnection() }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    return await fn(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('every implemented route actually dispatches (declared is not enough — it must respond)', () => {
  it('GET /healthz answers 200', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok' });
    });
  });

  it('GET /ping answers 200, identically to /healthz (the AgentCore alias)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/ping`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok' });
    });
  });

  it('POST /ping and GET /run are refused as method_not_allowed, not dispatched or 404', async () => {
    await withServer(async (base) => {
      const pingPost = await fetch(`${base}/ping`, { method: 'POST' });
      expect(pingPost.status).toBe(405);
      const runGet = await fetch(`${base}/run`);
      expect(runGet.status).toBe(405);
    });
  });

  it('POST /run answers 200 with an SSE stream ending run-done', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          runRequestBody(
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
          ),
        ),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('event: run-done');
    });
  });

  it('POST /invocations answers 200 with an SSE stream, identically to /run (the AgentCore alias)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/invocations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          runRequestBody(
            '33333333-3333-4333-8333-333333333333',
            '44444444-4444-4444-8444-444444444444',
          ),
        ),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('event: run-done');
    });
  });

  it('GET /invocations and POST /ping are method_not_allowed on the alias too', async () => {
    await withServer(async (base) => {
      const invocationsGet = await fetch(`${base}/invocations`);
      expect(invocationsGet.status).toBe(405);
    });
  });

  it('POST /interrupt with no run in flight is decisively answered (409), not 404 or 501', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: '11111111-1111-4111-8111-111111111111' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: 'no_run_in_flight',
      });
    });
  });
});

describe('POST /files and GET /files dispatch to their real validation boundaries', () => {
  it('POST /files rejects an empty non-archive body, not as unimplemented', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/files`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_archive' });
    });
  });

  it('GET /files requires a path selection, not as unimplemented', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/files`);
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: 'invalid_file_request',
      });
    });
  });
});

// --- B2: "and the status each one answers", derived from RUNTIME_HTTP_CONTRACT itself ----------
// The two describes below are the repair for round 1's `describe('every implemented route
// actually dispatches …')`, which was seven hand-typed `it()` cases and never looped over
// `RUNTIME_HTTP_CONTRACT` at all. Reproduced counter-example that made that shape necessary: add
// a sixth §14.3 endpoint to the fenced block, add `{ method: 'POST', path: '/shutdown', status:
// 'implemented' }` to the table, add both hand-typed literals the old test needed touching — and
// deliberately never wire `/shutdown` into `server.ts`. The old suite still passed, 20/20 green,
// because nothing in it ever asked the server to actually answer `/shutdown`. The loop below asks
// every entry the table has, so a route the table grows into either gets driven or fails here.

/** A `RunRequest` body with fresh ids, so two loop iterations against two independent servers
 *  never collide on a runId or sessionId `RunRequest` requires to be a valid UUID. */
function freshRunRequestBody(): unknown {
  return runRequestBody(randomUUID(), randomUUID());
}

/** The request this route's own declared method and path call for — a body only where the
 *  handler requires one to get past request validation before its declared status is reachable. */
function requestInitFor(route: ContractRoute): RequestInit {
  if (route.method === 'POST' && (route.path === '/run' || route.path === '/invocations')) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(freshRunRequestBody()),
    };
  }
  return { method: route.method };
}

describe('every entry in RUNTIME_HTTP_CONTRACT actually dispatches as its own declared status says', () => {
  for (const route of RUNTIME_HTTP_CONTRACT) {
    it(`${route.method} ${route.path} answers status=${route.status}, not 404`, async () => {
      await withServer(async (base) => {
        const res = await fetch(`${base}${route.path}`, requestInitFor(route));
        expect(res.status).not.toBe(404);
        if (route.status === 'not_implemented') {
          expect(res.status).toBe(501);
          expect((await res.json()) as { error: string }).toMatchObject({
            error: 'not_implemented',
          });
        } else {
          // 'implemented' means dispatched to a real handler — 404 (nothing answered this path)
          // and 501 (declared and stopped there) are exactly the two answers that would be a lie.
          expect(res.status).not.toBe(501);
        }
      });
    });
  }
});

describe('a method RUNTIME_HTTP_CONTRACT does not declare for a path is refused, not dispatched', () => {
  for (const route of RUNTIME_HTTP_CONTRACT) {
    const otherMethod = route.method === 'GET' ? 'POST' : 'GET';
    // `/files` declares both GET and POST, so "the other method" is itself a declared entry for
    // that path — skip it rather than assert a 405 the contract does not promise.
    const otherIsAlsoDeclared = RUNTIME_HTTP_CONTRACT.some(
      (candidate) => candidate.path === route.path && candidate.method === otherMethod,
    );
    if (otherIsAlsoDeclared) continue;
    it(`${otherMethod} ${route.path} is method_not_allowed (405)`, async () => {
      await withServer(async (base) => {
        const res = await fetch(`${base}${route.path}`, { method: otherMethod });
        expect(res.status).toBe(405);
      });
    });
  }
});

describe("an undeclared path still 404s (the classifier's final else rejects, ADR-0015)", () => {
  it('GET /not-a-route is 404, not 501', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/not-a-route`);
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'not_found' });
    });
  });
});
