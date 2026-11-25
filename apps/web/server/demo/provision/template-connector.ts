/**
 * How a template workspace stores a connector the demo agent names. The deployment's seed declares
 * a connector by its name, the tools that only read, the tools that would send or write outside,
 * and the writes the demo keeps once a person approved them (`DemoSeedConnector`, ADR-0169); the
 * template keeps no address and no secret of it. The row is an MCP connector the template never
 * runs: a stdio connector whose command is {@link DEMO_TEMPLATE_CONNECTOR_COMMAND} and whose
 * arguments are the declared tools, each marked `read:` or `write:`, and each recorded write as
 * `record:<write>:<kind>:<read>`. `planDemoConnector` reads the declaration back when a visitor's
 * demo is copied (`outside-tools.ts`), so the copy's stand-in offers exactly these tools.
 */
import {
  DemoRecordedWriteSchema,
  type DemoRecordedWrite,
} from '@indx-workspace/contracts/demo-operator';

/** The command of a template connector: not an executable, only the marker the row is read by. */
export const DEMO_TEMPLATE_CONNECTOR_COMMAND = 'demo-template-connector';

const READ_PREFIX = 'read:';
const WRITE_PREFIX = 'write:';
const RECORD_PREFIX = 'record:';

/** The arguments of the template row that declares `reads`, `writes` and `recorded`. */
export function templateConnectorArgs(
  reads: readonly string[],
  writes: readonly string[],
  recorded: readonly DemoRecordedWrite[] = [],
): readonly string[] {
  return [
    ...reads.map((tool) => READ_PREFIX + tool),
    ...writes.map((tool) => WRITE_PREFIX + tool),
    ...recorded.map((entry) => `${RECORD_PREFIX}${entry.write}:${entry.kind}:${entry.read}`),
  ];
}

/** A `record:` argument as a recorded write, or `null` when it is not one (a tool name has no `:`). */
function recordedWriteOf(arg: string): DemoRecordedWrite | null {
  const [write, kind, read, ...rest] = arg.slice(RECORD_PREFIX.length).split(':');
  if (rest.length > 0) return null;
  const parsed = DemoRecordedWriteSchema.safeParse({ write, kind, read });
  return parsed.success ? parsed.data : null;
}

/** The declared tools of a connector row, or `null` for a row the seed did not make. */
export function declaredTools(connector: {
  readonly command?: string | null;
  readonly args?: readonly string[] | null;
}): {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly recorded: readonly DemoRecordedWrite[];
} | null {
  if (connector.command !== DEMO_TEMPLATE_CONNECTOR_COMMAND) return null;
  const args = connector.args ?? [];
  const named = (prefix: string): string[] =>
    args.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  const recorded = args
    .filter((arg) => arg.startsWith(RECORD_PREFIX))
    .map(recordedWriteOf)
    .filter((entry): entry is DemoRecordedWrite => entry !== null);
  return { reads: named(READ_PREFIX), writes: named(WRITE_PREFIX), recorded };
}
