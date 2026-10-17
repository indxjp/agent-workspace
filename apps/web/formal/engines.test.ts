/**
 * Differential conformance for the `engines` family (ENG-02a #317, ENG-02b #318, ENG-02c #319): the
 * Lean engine contracts and the decisions that follow from them, replayed against the REAL code.
 *
 *   - `catalog.json`: the engine vocabulary in wire order. The Lean `WireEnum`s are the model;
 *     `ENGINE_IDS`, `WIRE_PROTOCOLS` and the deployment's registry are what is checked.
 *   - `schemas.json`: `EngineCapabilitiesSchema` and `EngineDescriptorSchema` over accepted and
 *     refused bodies. The model says which bodies are valid; the real zod schemas must agree.
 *   - `policy.json`: `parsePolicyBody`'s verdict for each body, registry and union answer. This is
 *     the one that matters most: it is where "the old `provider` discriminant is never silently
 *     accepted" stops being a comment.
 *   - `migration.json`: migration 0025's per-row rewrite. The SQL itself is exercised against a
 *     real PostgreSQL by `packages/core/src/db/repositories/engine-migration.test.ts`; what is
 *     replayed here is the rewrite whose keys and backfill value are read out of that SQL file.
 *   - `enforcement.json` (ENG-02b): the save-time capability check against `engineCapabilityRefusal`,
 *     and session engine pinning against the **real** `startRun` — the run route, with a run store
 *     installed, so that "and creates no run row" is checked on the rows and not on a verdict.
 *   - `sdk.json` (ENG-02c, #319): `GET /api/engines` as a projection of the registry, replayed
 *     against the **real route handler** through the RBAC harness — the registry the vector
 *     states is installed with `registerEngineForTests`, and the body the route produced is
 *     compared to the list the model says a client sees.
 *
 * A disagreement is a failing test, and the fix is never to edit a vector
 * (`docs/formal/00-orchestrator-prompt.md` §10).
 */
import {
  ENGINE_BUDGET_ENFORCEMENTS,
  ENGINE_IDS,
  ENGINE_LIMIT_ENFORCEMENTS,
  EngineCapabilitiesSchema,
  EngineCapabilityKeySchema,
  EngineDescriptorSchema,
  WIRE_PROTOCOLS,
} from '@indx-workspace/contracts/engines';
import { createClient } from '@indx-workspace/sdk';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { GET as getEngines } from '../app/api/engines/route';
import { engineCapabilityRefusal, parsePolicyBody } from '../server/agents/policy';
import { sessionForLaunch } from '../server/composition/session-launch';
import { listEngines } from '../server/engines/handlers';
import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
  registeredEngine,
  registeredEngineIds,
} from '../server/engines/registry';
import {
  clearEngineImagesConfiguredForTests,
  configureEngineImagesForTests,
} from '../server/engines/images';
import { parseRole } from '../server/rbac/roles';
import { installRbacHarness, TEST_WORKSPACE_ID } from '../server/rbac/testing';
import { installRunApi, resetRunApi } from '../server/runs/environment';
import { startRun } from '../server/runs/api';
import { InMemoryRunStore } from '../server/runs/store';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

const catalogVectors = loadVectors('engines', 'catalog.json');
const schemaVectors = loadVectors('engines', 'schemas.json');
const policyVectors = loadVectors('engines', 'policy.json');
const migrationVectors = loadVectors('engines', 'migration.json');
const enforcementVectors = loadVectors('engines', 'enforcement.json');
const sdkVectors = loadVectors('engines', 'sdk.json');

/** The schemas the `schemas.json` vectors name, so a vector cannot select an absent schema. */
const SCHEMAS = {
  EngineCapabilitiesSchema,
  EngineDescriptorSchema,
} as const;

function asStringArray(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value.map((entry, index) => asString(entry, `${what}[${String(index)}]`));
}

function asNullableString(value: unknown, what: string): string | null {
  return value === null ? null : asString(value, what);
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what}: expected a boolean`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what}: expected a number`);
  return value;
}

describe('engine catalogue', () => {
  it.each(catalogVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const expected = asRecord(vector.expected, vector.id);
    if (vector.id === 'vocabulary') {
      expect([...ENGINE_IDS]).toEqual(asStringArray(expected['engineIds'], vector.id));
      expect([...WIRE_PROTOCOLS]).toEqual(asStringArray(expected['wireProtocols'], vector.id));
      expect([...ENGINE_LIMIT_ENFORCEMENTS]).toEqual(
        asStringArray(expected['limitEnforcements'], vector.id),
      );
      expect([...ENGINE_BUDGET_ENFORCEMENTS]).toEqual(
        asStringArray(expected['budgetEnforcements'], vector.id),
      );
      return;
    }
    expect([...registeredEngineIds()]).toEqual(asStringArray(expected['registered'], vector.id));
  });
});

describe('engine schemas', () => {
  it.each(schemaVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const name = asString(input['schema'], `${vector.id} schema`);
    const schema = name in SCHEMAS ? SCHEMAS[name as keyof typeof SCHEMAS] : undefined;
    if (schema === undefined) throw new Error(`${vector.id}: no schema named ${name}`);
    const parsed = schema.safeParse(input['body']);
    // `output: null` is the model saying "this body is refused"; anything else is the body itself,
    // unchanged, which is what a no-transform schema round-trips to.
    if (expected['output'] === null) {
      expect(parsed.success, `${vector.id} should be refused`).toBe(false);
      return;
    }
    expect(parsed.success, `${vector.id} should be accepted`).toBe(true);
    expect(parsed.data).toEqual(expected['output']);
  });
});

describe('policy parser verdicts', () => {
  it.each(policyVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const registered = asStringArray(input['registered'], `${vector.id} registered`);
    const unionAccepts = asBoolean(input['unionAccepts'], `${vector.id} unionAccepts`);

    const result = parsePolicyBody(input['body'], registered);
    const verdict = asString(expected['verdict'], `${vector.id} verdict`);

    if (verdict === 'accepted') {
      // The model says the body clears both engine checks and reaches the union. The real union is
      // the one that decides, and the vector records what it says: a vector claiming `accepted`
      // while `unionAccepts` is false would be a contradiction the model cannot produce.
      expect(unionAccepts).toBe(true);
      expect(result.ok, `${vector.id}: ${JSON.stringify(result)}`).toBe(true);
      return;
    }
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const body = asRecord(result.result.body, `${vector.id} problem body`);
    const error = asRecord(body['error'], `${vector.id} problem error`);
    expect(error['code']).toBe(verdict);
    expect(result.result.status).toBe(expected['status']);
  });
});

/**
 * Migration 0025's rewrite, derived from the REAL SQL file rather than restated.
 *
 * The SQL runs against PostgreSQL in `engine-migration.test.ts`; this suite has no database, so it
 * reads `migrations/0025_name_the_engine_in_stored_rows.sql`, requires each of the two `UPDATE`s to
 * have exactly the shape below, and takes the renamed key, the new key and the backfilled engine
 * out of the file. Those parameters are then applied to each vector's row. Changing a key, the
 * backfill value or a `WHERE` guard in 0025 either stops the statement matching (a failure) or
 * changes what is applied to the rows (a disagreement with the model's vector).
 */
const MIGRATION_0025 = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../migrations/0025_name_the_engine_in_stored_rows.sql',
);

/** The file's statements, with `--` comments removed and whitespace collapsed. */
function migrationStatements(): readonly string[] {
  return readFileSync(MIGRATION_0025, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

/** The captures of the one statement `pattern` matches; zero or several matches fail. */
function onlyMatch(pattern: RegExp, what: string): readonly string[] {
  const matches = migrationStatements()
    .map((statement) => pattern.exec(statement))
    .filter((match): match is RegExpExecArray => match !== null);
  const [match] = matches;
  if (matches.length !== 1 || match === undefined) {
    throw new Error(
      `migration 0025: expected exactly one ${what} statement, found ${String(matches.length)}`,
    );
  }
  return match.slice(1).map((capture, index) => asString(capture, `${what} capture ${index}`));
}

/** `(policy - '<from>') || jsonb_build_object('<to>', policy ->> '<from>')`, guarded. */
const POLICY_REWRITE =
  /^UPDATE "agents" SET "policy" = \("policy" - '([a-z_]+)'\) \|\| jsonb_build_object\('([a-z_]+)', "policy" ->> '([a-z_]+)'\) WHERE "policy" IS NOT NULL AND "policy" \? '([a-z_]+)' AND NOT \("policy" \? '([a-z_]+)'\);$/;

/** `SET engine = '<engine>' WHERE engine IS NULL AND engine_session_id IS NOT NULL`. */
const SESSION_BACKFILL =
  /^UPDATE "sessions" SET "engine" = '([a-z0-9-]+)' WHERE "engine" IS NULL AND "engine_session_id" IS NOT NULL;$/;

function policyRewrite(): { readonly from: string; readonly to: string } {
  const [removed, added, carried, guarded, skipped] = onlyMatch(
    POLICY_REWRITE,
    'agents.policy rewrite',
  );
  // One key is removed, carried and required; the other is added and its presence skips the row.
  if (
    removed === undefined ||
    added === undefined ||
    removed !== carried ||
    removed !== guarded ||
    added !== skipped
  ) {
    throw new Error('migration 0025: the policy rewrite does not move one key to another');
  }
  return { from: removed, to: added };
}

function sessionBackfill(): string {
  const [engine] = onlyMatch(SESSION_BACKFILL, 'sessions backfill');
  if (engine === undefined) throw new Error('migration 0025: the backfill names no engine');
  return engine;
}

describe('migration 0025', () => {
  it.each(migrationVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);

    if (vector.id.startsWith('session/')) {
      const engineSessionId = asNullableString(input['engineSessionId'], vector.id);
      const engine = asNullableString(input['engine'], vector.id);
      // The file's `WHERE engine IS NULL AND engine_session_id IS NOT NULL`, with the value it sets.
      const backfilled = sessionBackfill();
      const migrated =
        engine === null && engineSessionId !== null
          ? { engineSessionId, engine: backfilled }
          : { engineSessionId, engine };
      expect(migrated.engineSessionId).toEqual(expected['engineSessionId']);
      expect(migrated.engine).toEqual(expected['engine']);
      expect(migrated.engineSessionId === null || migrated.engine !== null).toBe(
        expected['paired'],
      );
      return;
    }

    // The keys come from the file. A NULL column fails the `IS NOT NULL` guard and a document
    // already carrying the new key fails the `NOT ?` guard; otherwise the old key moves, carrying
    // its value, and every other key is left in place.
    const { from, to } = policyRewrite();
    const key = asNullableString(input['discriminantKey'], vector.id);
    const value = asNullableString(input['discriminantValue'], vector.id);
    const rewrittenKey = key === from ? to : key;
    expect(rewrittenKey).toEqual(expected['discriminantKey']);
    expect(value).toEqual(expected['discriminantValue']);
    expect(input['rest']).toEqual(expected['rest']);
  });
});

/** Every engine this deployment registers must be one the contracts publish. */
it('registers only engines the published catalogue names', () => {
  for (const id of registeredEngineIds()) {
    expect(ENGINE_IDS as readonly string[]).toContain(id);
  }
});

// ── ENG-02b: the two enforcements ────────────────────────────────────────────────────────────────

const ENFORCEMENT_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const ENFORCEMENT_AGENT = '33333333-3333-4333-8333-333333333333';
const ENFORCEMENT_SESSION = '44444444-4444-4444-8444-444444444444';

/**
 * A `claude-agent-sdk` descriptor whose three demandable capabilities are the vector's.
 *
 * It replaces the built-in descriptor rather than sitting beside it, which is the only way the
 * refusal is reachable: `AgentPolicy` has one arm, so no engine other than `claude-agent-sdk` can be
 * named by a body that parses at all. Every other field is the real descriptor's.
 */
function registerCapabilities(capabilities: {
  mcp: boolean;
  skills: boolean;
  subagents: boolean;
}): void {
  const claude = registeredEngine('claude-agent-sdk');
  if (claude === null) throw new Error('claude-agent-sdk is not registered');
  // `installed` is dropped rather than carried over: since ENG-07 it is the deployment's configured
  // image map, not a field a descriptor may state (`../server/engines/registry.ts`).
  registerEngineForTests({
    id: claude.id,
    displayName: claude.displayName,
    version: claude.version,
    capabilities: { ...claude.capabilities, ...capabilities },
  });
}

describe('engine enforcement', () => {
  afterEach(() => {
    clearEnginesRegisteredForTests();
    resetRunApi();
  });

  it.each(
    enforcementVectors.filter((v) => v.id.startsWith('capability/')).map((v) => [v.id, v] as const),
  )('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const capabilities = asRecord(input['capabilities'], `${vector.id} capabilities`);
    const demand = asRecord(input['demand'], `${vector.id} demand`);

    registerCapabilities({
      mcp: asBoolean(capabilities['mcp'], `${vector.id} mcp`),
      skills: asBoolean(capabilities['skills'], `${vector.id} skills`),
      subagents: asBoolean(capabilities['subagents'], `${vector.id} subagents`),
    });
    const refusal = engineCapabilityRefusal('claude-agent-sdk', {
      connectors: asBoolean(demand['connectors'], `${vector.id} connectors`),
      skills: asBoolean(demand['skills'], `${vector.id} demanded skills`),
      subagents: asBoolean(demand['subagents'], `${vector.id} demanded subagents`),
    });

    if (asString(expected['verdict'], vector.id) === 'saved') {
      expect(refusal, `${vector.id} should be saved`).toBeNull();
      expect(expected['details']).toEqual([]);
      return;
    }
    expect(refusal, `${vector.id} should be refused`).not.toBeNull();
    if (refusal === null) return;
    const body = asRecord(refusal.body, `${vector.id} problem body`);
    const error = asRecord(body['error'], `${vector.id} problem error`);
    expect(error['code']).toBe('engine_capability_unsupported');
    expect(refusal.status).toBe(expected['status']);
    // The capability travels as the single `details` entry, and it is one the contract publishes.
    expect(error['details']).toEqual(expected['details']);
    for (const detail of asStringArray(error['details'], `${vector.id} details`)) {
      expect(EngineCapabilityKeySchema.safeParse(detail).success).toBe(true);
    }
  });

  it.each(
    enforcementVectors.filter((v) => v.id.startsWith('pinning/')).map((v) => [v.id, v] as const),
  )('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const sessionEngine = asNullableString(input['sessionEngine'], `${vector.id} sessionEngine`);
    const agentEngine = asString(input['agentEngine'], `${vector.id} agentEngine`);

    const store = new InMemoryRunStore();
    const launched: unknown[] = [];
    installRunApi({
      authenticate: () =>
        Promise.resolve({
          principalId: '77777777-7777-4777-8777-777777777777',
          ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
          userId: '66666666-6666-4666-8666-666666666666',
          workspaceId: ENFORCEMENT_WORKSPACE,
          role: 'owner' as const,
          scope: null,
        }),
      findAgent: (principal, agentId) =>
        Promise.resolve(
          agentId === ENFORCEMENT_AGENT
            ? { id: ENFORCEMENT_AGENT, workspaceId: principal.workspaceId, engine: agentEngine }
            : null,
        ),
      openSession: () =>
        Promise.resolve({
          id: ENFORCEMENT_SESSION,
          agentId: ENFORCEMENT_AGENT,
          engine: sessionEngine,
        }),
      ownsRun: () => Promise.resolve(true),
      store,
      launch: (context) => {
        launched.push(context);
      },
    });

    const response = await startRun(
      new Request(`http://web/api/agents/${ENFORCEMENT_AGENT}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'replay', sessionId: ENFORCEMENT_SESSION }),
      }),
      ENFORCEMENT_AGENT,
    );

    expect(response.status).toBe(expected['status']);
    const persisted = await store.listRuns(ENFORCEMENT_WORKSPACE, { limit: 10 });
    // The half a verdict cannot state: the rows themselves.
    expect(persisted.items).toHaveLength(asNumber(expected['runsAfter'], `${vector.id} runsAfter`));

    if (asString(expected['verdict'], vector.id) === 'session_engine_mismatch') {
      const body = asRecord(await response.json(), `${vector.id} problem body`);
      const error = asRecord(body['error'], `${vector.id} problem error`);
      expect(error['code']).toBe('session_engine_mismatch');
      expect(launched).toHaveLength(0);
      return;
    }
    const body = asRecord(await response.json(), `${vector.id} run body`);
    const run = asRecord(body['run'], `${vector.id} run`);
    expect(run['engine']).toBe(expected['runEngine']);
    expect(launched).toHaveLength(1);
  });

  it.each(
    enforcementVectors.filter((v) => v.id.startsWith('pinning/')).map((v) => [v.id, v] as const),
  )('%s carries the session pin into the launch reference', (_id, vector) => {
    // The other side of "a run never re-pins the session": the launch reference the route compares
    // against is the session row's own engine, carried across unchanged by `session-launch.ts`.
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const sessionEngine = asNullableString(input['sessionEngine'], `${vector.id} sessionEngine`);
    const ref = sessionForLaunch({
      id: ENFORCEMENT_SESSION,
      workspaceId: ENFORCEMENT_WORKSPACE,
      agentId: ENFORCEMENT_AGENT,
      userId: null,
      ownerPrincipalId: 'principal-1',
      projectId: null,
      engineSessionId: null,
      engine: sessionEngine === null ? null : 'claude-agent-sdk',
      agentVersionId: null,
      title: null,
      status: 'active',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    // A session row can only carry a published engine, so the reference is `null` exactly when the
    // vector's session is unpinned — which is what the expected `sessionEngine` records.
    expect(ref.engine === null).toBe(expected['sessionEngine'] === null);
  });
});

/**
 * `sdk.json` (ENG-02c, #319), replayed against the real `GET /api/engines`.
 *
 * The model's `Descriptor` carries the four fields the projection can observe; `capabilities` is
 * `Contracts/Engines.lean`'s business and is checked by `schemas.json`. So the route's body is
 * projected onto those four fields before the comparison, and every other field of it is already
 * held to `EngineDescriptorSchema` by the route itself.
 */
const MEMBER = { email: 'formal-engines@example.test' };

/** The `{ id, displayName, version, installed }` projection the Lean model states. */
function projectDescriptor(value: unknown, what: string): Record<string, unknown> {
  const descriptor = asRecord(value, what);
  return {
    id: descriptor['id'],
    displayName: descriptor['displayName'],
    version: descriptor['version'],
    installed: descriptor['installed'],
  };
}

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value;
}

describe('the engine catalogue route is a projection of the registry', () => {
  afterEach(() => {
    clearEnginesRegisteredForTests();
    clearEngineImagesConfiguredForTests();
  });

  it.each(sdkVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);

    if (vector.id === 'request') {
      // The call the real SDK makes, as the CLI and the browser both reach it: `engines.list()`
      // through a fetch double that records the request and answers with the route's own body.
      // `expected['columns']` is replayed against the real table header by
      // `tests/formal/engines.test.ts`, which drives the `aw` binary.
      const accepted = expected['expect'];
      if (typeof accepted !== 'number') throw new Error(`${vector.id}: expect is not a number`);
      const served = listEngines();
      expect(served.status).toBe(accepted);
      const seen: Request[] = [];
      const sdkAnswering = (status: number) =>
        createClient({
          baseUrl: 'https://aw.example.com',
          auth: { kind: 'api-key', apiKey: 'ak_live_k' },
          fetch: (request, init) => {
            seen.push(new Request(request, init));
            return Promise.resolve(
              new Response(JSON.stringify(served.body), {
                status,
                headers: { 'content-type': 'application/json' },
              }),
            );
          },
        });

      await expect(sdkAnswering(accepted).engines.list()).resolves.toBeDefined();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe(expected['method']);
      expect(new URL(seen[0]?.url ?? '').pathname).toBe(expected['path']);
      // The accepted status is exactly the model's: any other, even another success, is refused.
      await expect(sdkAnswering(accepted + 1).engines.list()).rejects.toMatchObject({
        status: accepted + 1,
      });
      return;
    }
    if (vector.id.startsWith('authz/')) {
      // The decision itself is replayed by `authz-decide.test.ts` over the whole matrix; what
      // this vector pins is that the catalogue route is in it and readable by every role.
      const readableBy = asArray(expected['readableBy'], vector.id).map((entry, index) => {
        const role = parseRole(asString(entry, `${vector.id} role ${String(index)}`));
        if (role === null) throw new Error(`${vector.id}: "${String(entry)}" is not a role`);
        return role;
      });
      const harness = installRbacHarness(
        readableBy.map((role) => ({
          email: `${role}@example.test`,
          name: 'Formal',
          workspaceId: TEST_WORKSPACE_ID,
          role,
        })),
      );
      try {
        for (const role of readableBy) {
          const response = await harness.call(getEngines, {
            method: 'GET',
            path: '/api/engines',
            as: { email: `${role}@example.test` },
          });
          expect(response.status, `${vector.id}: ${role}`).toBe(200);
        }
      } finally {
        harness.teardown();
      }
      return;
    }

    // ENG-07 (#306): `installed` is the deployment's configured `engine to image` map and is no
    // longer a field of a registered descriptor, so the vector's `installed` flags are replayed as
    // the *configuration* this deployment has. That makes the assertion below the T1 statement
    // itself — the catalogue the route serves is the map — rather than an echo of a field the test
    // handed the registry a moment earlier.
    configureEngineImagesForTests(
      new Map(
        asArray(expected['engines'] ?? [], vector.id)
          .map((entry, index) => asRecord(entry, `${vector.id} engine ${String(index)}`))
          .filter((descriptor) => descriptor['installed'] === true)
          .map((descriptor) => [
            asString(descriptor['id'], `${vector.id} engine id`),
            `registry.example/agent-workspace/runtime-${asString(descriptor['id'], 'id')}:test`,
          ]),
      ),
    );

    for (const [index, extra] of asArray(input['extraEngines'], vector.id).entries()) {
      const descriptor = asRecord(extra, `${vector.id} extra ${String(index)}`);
      registerEngineForTests({
        id: asString(descriptor['id'], `${vector.id} extra id`),
        displayName: asString(descriptor['displayName'], `${vector.id} extra displayName`),
        version: asString(descriptor['version'], `${vector.id} extra version`),
        capabilities: EngineCapabilitiesSchema.parse({
          mcp: false,
          skills: false,
          subagents: false,
          resume: false,
          fork: false,
          interrupt: false,
          streamingText: false,
          reasoning: false,
          maxTurns: 'adapter',
          maxBudget: 'none',
          wireProtocols: ['anthropic-messages'],
        }),
      });
    }

    const harness = installRbacHarness([
      { email: MEMBER.email, name: 'Formal', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
    ]);
    try {
      const response = await harness.call(getEngines, {
        method: 'GET',
        path: '/api/engines',
        as: MEMBER,
      });

      expect(response.status).toBe(expected['status']);
      if (expected['engines'] === null) {
        // Refused whole: no engine of the registry crosses, not even a describable one.
        const body = asRecord(response.body, `${vector.id} problem body`);
        const error = asRecord(body['error'], `${vector.id} problem error`);
        expect(error['code']).toBe(expected['code']);
        expect(response.text).not.toContain('claude-agent-sdk');
        return;
      }
      const body = asRecord(response.body, `${vector.id} body`);
      const served = asArray(body['engines'], `${vector.id} engines`);
      expect(
        served.map((entry, index) => projectDescriptor(entry, `${vector.id}[${index}]`)),
      ).toEqual(
        asArray(expected['engines'], `${vector.id} expected`).map((entry, index) =>
          projectDescriptor(entry, `${vector.id} expected[${index}]`),
        ),
      );
    } finally {
      harness.teardown();
    }
  });
});
