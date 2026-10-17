export function teardown(
  lane: { id: string; key: string; host: string; credentials: readonly string[] },
  runId: string,
  env: Record<string, string | undefined>,
  request?: typeof fetch,
): Promise<{ removed: string[]; leftovers: string[] }>;
