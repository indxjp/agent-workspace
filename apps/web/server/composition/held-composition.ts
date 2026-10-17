/**
 * The composition root that Next.js instrumentation installed in this process, held so the server
 * that started Next can release its database pools when it closes (S1-25, issue #510, ADR-0112).
 *
 * Next compiles `instrumentation.ts` into its own bundle, so a module-level variable there is not
 * the one `start.ts` would see. The handle is therefore kept on `globalThis` under a registered
 * symbol, which every copy of this module resolves to the same key.
 *
 * Without this, the pools stayed open until the process exited. The local runtime stops its
 * embedded PostgreSQL after closing the server, so every idle pooled client was terminated with
 * `57P01` on a normal Ctrl+C.
 */

/** What is held: anything that releases its resources once. */
export interface HeldComposition {
  close(): Promise<void>;
}

const HELD_COMPOSITION = Symbol.for('indx.aw.web.held-composition');

function isHeldComposition(value: unknown): value is HeldComposition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'close' in value &&
    typeof value.close === 'function'
  );
}

/** Hold `composition` for {@link closeHeldComposition}, replacing any held before. */
export function holdComposition(composition: HeldComposition): void {
  Reflect.set(globalThis, HELD_COMPOSITION, composition);
}

/** Release and forget the held composition. Resolves at once when none is held. */
export async function closeHeldComposition(): Promise<void> {
  const held: unknown = Reflect.get(globalThis, HELD_COMPOSITION);
  Reflect.deleteProperty(globalThis, HELD_COMPOSITION);
  if (isHeldComposition(held)) await held.close();
}
