/**
 * How a template workspace stores a connector the demo agent names. The deployment's seed declares
 * a connector by its name and the tools that only read and the tools that would send or write
 * outside (`DemoSeedConnector`); the template keeps no address and no secret of it. The row is an
 * MCP connector the template never runs: a stdio connector whose command is
 * {@link DEMO_TEMPLATE_CONNECTOR_COMMAND} and whose arguments are the declared tools, each marked
 * `read:` or `write:`. `planDemoConnector` reads the declaration back when a visitor's demo is
 * copied (`outside-tools.ts`), so the copy's stand-in offers exactly these tools.
 */

/** The command of a template connector: not an executable, only the marker the row is read by. */
export const DEMO_TEMPLATE_CONNECTOR_COMMAND = 'demo-template-connector';

const READ_PREFIX = 'read:';
const WRITE_PREFIX = 'write:';

/** The arguments of the template row that declares `reads` and `writes`. */
export function templateConnectorArgs(
  reads: readonly string[],
  writes: readonly string[],
): readonly string[] {
  return [...reads.map((tool) => READ_PREFIX + tool), ...writes.map((tool) => WRITE_PREFIX + tool)];
}

/** The declared tools of a connector row, or `null` for a row the seed did not make. */
export function declaredTools(connector: {
  readonly command?: string | null;
  readonly args?: readonly string[] | null;
}): { readonly reads: readonly string[]; readonly writes: readonly string[] } | null {
  if (connector.command !== DEMO_TEMPLATE_CONNECTOR_COMMAND) return null;
  const args = connector.args ?? [];
  const named = (prefix: string): string[] =>
    args.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  return { reads: named(READ_PREFIX), writes: named(WRITE_PREFIX) };
}
