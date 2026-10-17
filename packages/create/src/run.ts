/**
 * `@indx-workspace/create` — what `npm create @indx-workspace <directory>` runs.
 *
 * npm maps `npm create @scope` to the package `@scope/create` and runs its one bin, so this
 * package exists only to be that name. It is `create-agent-workspace` of `@indx-workspace/cli`,
 * at the same lock-step version, with the same arguments and the same refusal handling: nothing is
 * generated here that the CLI's own generator would not generate.
 */
import { runAsProcess, runCreateCommand } from '@indx-workspace/cli/create';

/** Run the generator with the arguments `npm create` passed after the package name. */
export function runCreate(argv: readonly string[]): Promise<number> {
  return runAsProcess(() => runCreateCommand([...argv]));
}
