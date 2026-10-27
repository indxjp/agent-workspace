/**
 * The composition root that Next.js instrumentation installed in this process, held so the server
 * that started Next can release its database pools when it closes (S1-25, issue #510, ADR-0112).
 *
 * Next compiles `instrumentation.ts` into its own bundle, so a module-level variable there is not
 * the one `start.ts` would see. The handle is therefore kept in a runtime slot, which every copy of
 * this module resolves to the same `globalThis` key.
 *
 * Without this, the pools stayed open until the process exited. The local runtime stops its
 * embedded PostgreSQL after closing the server, so every idle pooled client was terminated with
 * `57P01` on a normal Ctrl+C.
 */
import { defineSlot } from '../runtime-slot.ts';

/** What is held: anything that releases its resources once. */
export interface HeldComposition {
  close(): Promise<void>;
}

const held = defineSlot<HeldComposition>('__agentWorkspaceHeldComposition__');

/** Hold `composition` for {@link closeHeldComposition}, replacing any held before. */
export function holdComposition(composition: HeldComposition): void {
  held.set(composition);
}

/** Release and forget the held composition. Resolves at once when none is held. */
export async function closeHeldComposition(): Promise<void> {
  const composition = held.current();
  held.clear();
  await composition?.close();
}
