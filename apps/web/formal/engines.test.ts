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
 *   - `enforcement.json` (ENG-02b): replayed by `engine-enforcement.test.ts`.
 *   - `sdk.json` (ENG-02c, #319): replayed by `engine-catalogue-route.test.ts`.
 *
 * A disagreement is a failing test, and the fix is never to edit a vector
 * (`docs/20-design/formal/00-orchestrator-prompt.md` §10).
 */
import {
  ENGINE_BUDGET_ENFORCEMENTS,
  ENGINE_IDS,
  ENGINE_LIMIT_ENFORCEMENTS,
  EngineCapabilitiesSchema,
  EngineDescriptorSchema,
  WIRE_PROTOCOLS,
} from '@indx-workspace/contracts/engines';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parsePolicyBody } from '../server/agents/policy';
import { registeredEngineIds } from '../server/engines/registry';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';
import { asBoolean, asNullableString, asStringArray } from './engines.test-support';

const catalogVectors = loadVectors('engines', 'catalog.json');
const schemaVectors = loadVectors('engines', 'schemas.json');
const policyVectors = loadVectors('engines', 'policy.json');
const migrationVectors = loadVectors('engines', 'migration.json');

/** The schemas the `schemas.json` vectors name, so a vector cannot select an absent schema. */
const SCHEMAS = {
  EngineCapabilitiesSchema,
  EngineDescriptorSchema,
} as const;

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
