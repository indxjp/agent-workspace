/**
 * Pick a preferred model id from a provider's discovered list.
 *
 * Provider discovery may expose a dated model id without exposing its stable alias (Anthropic's
 * `/v1/models` can list only `claude-sonnet-4-5-20250929`, not `claude-sonnet-4-5`). The exact
 * preferred id wins when listed; otherwise the newest dated release `<preferred>-YYYYMMDD` of that
 * same model is chosen; otherwise there is no match.
 *
 * Shared by first-run setup's seeded default (`../composition/setup.ts`) and the run model ladder's
 * deployment default layer (`../compose/run-request.ts`, issue #506).
 */
export function selectPreferredModel(
  preferred: string,
  discoveredIds: readonly string[],
): string | null {
  if (discoveredIds.includes(preferred)) return preferred;

  const datedPrefix = `${preferred}-`;
  return (
    discoveredIds
      .filter((id) => {
        if (!id.startsWith(datedPrefix)) return false;
        return /^\d{8}$/u.test(id.slice(datedPrefix.length));
      })
      .toSorted()
      .at(-1) ?? null
  );
}
