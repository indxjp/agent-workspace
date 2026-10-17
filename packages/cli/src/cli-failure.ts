/**
 * The one place either binary turns a refusal into process output.
 *
 * `ProbeRefusedError` keeps the driver's own failure as its `cause` on the stated grounds that a
 * PostgreSQL or S3 error routinely quotes the connection string it was given (`validate.ts`), and
 * `create --validate` re-wraps that refusal with a second `{ cause }`. Node's default handler for
 * a rejected top-level `await` prints the whole chain and a stack trace, so letting a refusal
 * escape `create-agent-workspace` or `agent-workspace` is precisely how a connection string
 * reaches a CI log — the pipelines all three deploy guides tell an operator to run these commands
 * in. Both entry points therefore run their command through here, which is what makes the
 * guarantee `validate.ts`, ADR-0055 and `packages/cli/README.md` state true of the *process* and
 * not only of the error object the tests could already see.
 */

/** The exit code a refused command leaves behind. */
const REFUSED = 1;

/** The exit code of a command that was used wrongly: a missing or malformed setting (#879). */
const USAGE = 2;

/**
 * A refusal that is the caller's to fix by changing the command line: exit 2, and `fix` is
 * printed after the message as `fix: <fix>`. Refusals that predate it keep exit 1.
 */
export class CreateUsageError extends Error {
  override readonly name = 'CreateUsageError';
  readonly fix: string | undefined;

  constructor(message: string, fix?: string) {
    super(message);
    this.fix = fix;
  }
}

/**
 * The one line a refusal becomes: `message` and nothing else.
 *
 * Everything beneath `message` — `cause`, and the stack — is the driver's own text, which is the
 * reason a refusal carries a message of its own in the first place. A thrown non-`Error` is
 * stringified rather than inspected: a dependency may reject with anything, and the handler that
 * exists to keep provider text out of a log must not start reading unknown objects for a message.
 */
export function refusalText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

export async function runAsProcess(
  run: () => Promise<void>,
  write: (chunk: string) => void = (chunk) => void process.stderr.write(chunk),
): Promise<number> {
  try {
    await run();
    // A command that finished without succeeding (Ctrl-C at a question is 130, a failed install or
    // dev run leaves its own code) says so through `process.exitCode`. The callers assign what this
    // returns to `process.exitCode`, so a plain 0 here would erase it (BH061-014).
    return Number(process.exitCode ?? 0) || 0;
  } catch (error) {
    write(`${refusalText(error)}\n`);
    if (error instanceof CreateUsageError) {
      if (error.fix !== undefined) write(`fix: ${error.fix}\n`);
      return USAGE;
    }
    return REFUSED;
  }
}
