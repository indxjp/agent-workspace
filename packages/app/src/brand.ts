/**
 * The mark every value from `@indx-workspace/app` carries (issue #1501).
 *
 * A copy of `@indx-workspace/sdk/define`'s brand under its own registry key: the SDK's `DefineKind`
 * is closed on purpose and its `brand` is not exported, so the app kit brands with
 * `Symbol.for('agentworkspace.dev/app')`. The symbol comes from the global registry, so two copies
 * of this module (an app's own `node_modules` and the copy the `aw-app` bin loads) mark and
 * recognise the same values. It is attached non-enumerable, so it never appears in a spread, in
 * `JSON.stringify` or in a strict schema's unknown-key check.
 */
const APP_BRAND: unique symbol = Symbol.for('agentworkspace.dev/app');

/**
 * What a branded value was made by: `defineResource`, `defineApp`, a field builder or
 * `defineRecipe`.
 */
export type AppKind = 'resource' | 'app' | 'field' | 'recipe';

/** A value marked as having passed app-kit validation for the kind `K`. */
export interface AppBranded<K extends AppKind> {
  readonly [APP_BRAND]: K;
}

/**
 * Attaches the brand of `kind` to `value`, non-enumerable, and freezes it. `value` must be a fresh
 * object the caller owns: it is changed in place.
 */
export function brand<T extends object, K extends AppKind>(
  value: T,
  kind: K,
): Readonly<T & AppBranded<K>> {
  Object.defineProperty(value, APP_BRAND, {
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
 * brand does not count: an `Object.create(definedResource)` with fields of its own was never
 * checked.
 */
export function hasBrand<K extends AppKind>(value: unknown, kind: K): value is AppBranded<K> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.getOwnPropertyDescriptor(value, APP_BRAND)?.value === kind;
}
