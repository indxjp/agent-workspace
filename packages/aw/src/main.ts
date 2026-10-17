import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { createClient, type ClientAuth } from '@indx-workspace/sdk';

import { parseArguments, type ParsedArguments } from './args.js';
import { assertSupportedFlags, type CommandContext } from './command.js';
import { resolveCommand } from './commands/index.js';
import { resolveConfig, type CliCredential } from './config.js';
import { helpText } from './help.js';
import { stdinOnce, UsageError, type CliIo } from './io.js';
import { EXIT_CODE, outputMode, reportFailure, writeResult, type ExitCode } from './output.js';
import { AW_VERSION, versionText } from './version.js';

function unknownCommand(words: readonly string[]): UsageError {
  // BH061-041: `aw agents` names a family, not an unknown command; it needs one of its commands.
  const named = helpText(words);
  if (words.length > 0 && named !== '') {
    return new UsageError(`"aw ${words.join(' ')}" needs a command\n\n${named}`);
  }
  const family = words[0];
  const familyHelp = family === undefined ? '' : helpText([family]);
  return new UsageError(
    familyHelp === ''
      ? `unknown command "${words.join(' ')}"`
      : `unknown command "${words.join(' ')}"\n\n${familyHelp}`,
  );
}

/**
 * The SDK credential for a resolved one. `none` becomes `session`, which sends no credential
 * header at all; in Node there is no cookie jar for `credentials: 'include'` to reach.
 */
function clientAuth(credential: CliCredential): ClientAuth {
  switch (credential.kind) {
    case 'api-key':
      return { kind: 'api-key', apiKey: credential.apiKey };
    case 'user-token':
      return { kind: 'user-token', token: credential.token };
    case 'none':
      return { kind: 'session' };
    default: {
      const unreachable: never = credential;
      // The credential itself is never interpolated: it may be a secret.
      throw new Error(`unclassified credential of type ${typeof unreachable}`);
    }
  }
}

/**
 * `--help` anywhere, `aw help [words]`, or a bare `aw`, prints the tree (of the family or command
 * named, if one is).
 */
function helpRequested(args: ParsedArguments): boolean {
  return (
    args.switches.has('help') || args.positionals.length === 0 || args.positionals[0] === 'help'
  );
}

async function dispatch(
  args: ParsedArguments,
  io: CliIo,
  signal: AbortSignal,
  /** Receives the control plane URL once it is resolved, for the failure report. */
  reached: { url?: string },
): Promise<ExitCode> {
  const resolved = resolveCommand(args.positionals);
  if (resolved === null) throw unknownCommand(args.positionals);
  const target = resolved.command;
  assertSupportedFlags(target, args);
  const readStdin = stdinOnce(io);
  const mode = outputMode(args);
  if (target.controlPlane === 'none') {
    // Issue #451: a local command resolves no configuration and builds no client.
    await target.run({
      io,
      args,
      positionals: resolved.rest,
      mode,
      signal,
      readStdin,
      cwd: io.cwd,
    });
    return EXIT_CODE.ok;
  }
  const config = await resolveConfig({
    args,
    env: io.env,
    homeDir: io.homeDir,
    cwd: io.cwd,
    readStdin,
    credentialRequired: target.credential !== 'none',
  });
  reached.url = config.url;
  for (const notice of config.notices) io.stderr(`note: ${notice}\n`);
  const client = createClient({
    baseUrl: config.url,
    auth: clientAuth(config.credential),
    fetch: io.fetch,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  });
  const context: CommandContext = {
    client,
    baseUrl: config.url,
    io,
    args,
    positionals: resolved.rest,
    mode,
    signal,
    readStdin,
  };
  const result = await target.run(context);
  if (result === undefined) return EXIT_CODE.ok;
  writeResult(io, mode, result.value, result.columns);
  return result.failed === true ? EXIT_CODE.problem : EXIT_CODE.ok;
}

/**
 * Parse, configure, run one command, render, and answer with the exit code. Every failure is
 * caught here and classified once; nothing below this function writes an exit code.
 */
export async function main(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const controller = new AbortController();
  const reached: { url?: string } = {};
  const onInterrupt = (): void => {
    controller.abort();
  };
  if (io.signal?.aborted === true) controller.abort();
  io.signal?.addEventListener('abort', onInterrupt, { once: true });
  try {
    const args = parseArguments(argv);
    if (args.switches.has('version')) {
      const mode = outputMode(args);
      // BH061-042: `--json`/`--jsonl` are honoured here too, as on every other command.
      if (mode.json || mode.jsonl)
        writeResult(io, mode, { aw: AW_VERSION, contracts: CONTRACTS_VERSION });
      else io.stdout(versionText());
      return EXIT_CODE.ok;
    }
    if (helpRequested(args)) {
      const words = args.positionals[0] === 'help' ? args.positionals.slice(1) : args.positionals;
      const text = helpText(words);
      if (text === '') throw unknownCommand(words);
      if (args.positionals.length === 0 && !args.switches.has('help')) {
        io.stderr(text);
        return EXIT_CODE.usage;
      }
      io.stdout(text);
      return EXIT_CODE.ok;
    }
    return await dispatch(args, io, controller.signal, reached);
  } catch (error) {
    return reportFailure(io, error, controller.signal.aborted, reached.url);
  } finally {
    io.signal?.removeEventListener('abort', onInterrupt);
  }
}
