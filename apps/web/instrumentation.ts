/**
 * Isomorphic Next.js instrumentation entrypoint.
 *
 * Next compiles this file for both Node and Edge. Keeping the Node composition root behind the
 * compile-time runtime branch prevents PostgreSQL, filesystem, crypto, and process adapters from
 * entering the Edge graph while retaining the standard instrumentation convention.
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    const node = await import('./instrumentation-node');
    const composition = await node.register();
    // Held so `startWeb`'s `close` releases the database pools before the server's owner stops
    // PostgreSQL (S1-25, #510). `next start` never closes it; process exit does.
    if (composition !== undefined) node.holdComposition(composition);
  }
}
