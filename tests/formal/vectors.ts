/**
 * Loads the differential test vectors the Lean model emits (`lake exe vectors`, committed under
 * `formal/generated/vectors/<family>/`). A vector is `{ id, input, expected, witnesses }`: an
 * input, the model's answer, and the Lean theorems that answer witnesses. The suites in this
 * directory and in `apps/<app>/formal/` replay each vector against the real TypeScript; a disagreement is a failing test, and
 * the fix is never to edit a vector (docs/formal/00-orchestrator-prompt.md §10).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FormalVector {
  readonly id: string;
  readonly input: unknown;
  readonly expected: unknown;
  readonly witnesses: readonly string[];
}

const VECTORS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../formal/generated/vectors',
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVector(value: unknown, source: string): FormalVector {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    !('input' in value) ||
    !('expected' in value) ||
    !Array.isArray(value['witnesses']) ||
    !value['witnesses'].every((w): w is string => typeof w === 'string')
  ) {
    throw new Error(`${source}: malformed vector ${JSON.stringify(value)}`);
  }
  return {
    id: value['id'],
    input: value['input'],
    expected: value['expected'],
    witnesses: value['witnesses'],
  };
}

/**
 * Read one family's vector file. Throws on a missing or malformed file, and on an empty one: a
 * suite that replays nothing is not a pass.
 */
export function loadVectors(family: string, file: string): readonly FormalVector[] {
  const source = path.join(VECTORS_ROOT, family, file);
  const parsed: unknown = JSON.parse(readFileSync(source, 'utf8'));
  if (!isRecord(parsed) || parsed['family'] !== family || !Array.isArray(parsed['vectors'])) {
    throw new Error(`${source}: not a vector file for family ${family}`);
  }
  const vectors = parsed['vectors'].map((v: unknown) => parseVector(v, source));
  if (vectors.length === 0) throw new Error(`${source}: contains no vectors`);
  return vectors;
}

/** Narrow a vector field to a string-keyed record, failing loudly on anything else. */
export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error(`${what}: expected an object, got ${JSON.stringify(value)}`);
  return value;
}

/** Narrow a vector field to a string, failing loudly on anything else. */
export function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${what}: expected a string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The model's `drizzle-kit` snapshot path, relative to the repository root:
 * `migrations/meta/` + `Er.Snapshot.file`, the pin `pnpm formal:generate` writes from the latest
 * migration, as the `er-core` catalogue vector carries it.
 */
export const MODEL_SNAPSHOT = `migrations/meta/${asString(
  asRecord(loadVectors('er-core', 'catalogue.json')[0]?.expected, 'er-core catalogue')['snapshot'],
  'er-core catalogue snapshot',
)}`;
