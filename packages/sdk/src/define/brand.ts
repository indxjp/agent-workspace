/**
 * The mark every value from `@indx-workspace/sdk/define` carries (issue #445).
 *
 * The symbol comes from the global registry (`Symbol.for`), so two copies of this module — a
 * project's own `node_modules` and the copy a CLI bundles — mark and recognise the same values. Its
 * value names what was defined. It is attached non-enumerable, so it never appears in a spread, in
 * `JSON.stringify` or in a strict schema's unknown-key check: a branded value serialises exactly as
 * what was written.
 */
const DEFINE_BRAND: unique symbol = Symbol.for('agentworkspace.dev/define');

/**
 * What a branded value was made by: `defineAgent`, `defineSurface`, `mcp`, `skill`, `files`,
 * `secret`, `openapiTool`, `postgresTool` or `defineTool`.
 */
export type DefineKind =
  'agent' | 'surface' | 'mcp' | 'skill' | 'files' | 'secret' | 'openapi' | 'postgres' | 'code';

/** A value marked as having passed `define` validation for the kind `K`. */
export interface Branded<K extends DefineKind> {
  readonly [DEFINE_BRAND]: K;
}

/**
 * Attaches the brand of `kind` to `value`, non-enumerable, and freezes it. `value` must be a fresh
 * object the caller owns: it is changed in place.
 */
export function brand<T extends object, K extends DefineKind>(
  value: T,
  kind: K,
): Readonly<T & Branded<K>> {
  Object.defineProperty(value, DEFINE_BRAND, {
    value: kind,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  if (!hasBrand(value, kind)) {
    throw new TypeError(`the ${kind} value could not be branded`);
  }
  return Object.freeze(value);
}

/**
 * Whether `value` is an object carrying the brand of `kind` as its own property. An inherited
 * brand does not count: an `Object.create(definedAgent)` with fields of its own was never checked.
 */
export function hasBrand<K extends DefineKind>(value: unknown, kind: K): value is Branded<K> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.getOwnPropertyDescriptor(value, DEFINE_BRAND)?.value === kind;
}
