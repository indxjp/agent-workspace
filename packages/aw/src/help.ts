import { setupFlagsHelp } from '@indx-workspace/sdk/project';

import type { Command } from './command.js';
import { commandsUnder, resolveCommand } from './commands/index.js';

const GLOBAL_FLAGS = `
Configuration (flags, then AGENT_WORKSPACE_URL / AGENT_WORKSPACE_API_KEY, then the local URL of
./agent-workspace.yaml, then the default profile; aw init and aw dev take none of these):
  --url <url>            the control plane
  --api-key-stdin        read the API key from stdin (a key is never accepted as a flag value)
  --profile <name>       a profile from ~/.config/agent-workspace/profiles.json
  --timeout <ms>         abort a request that produces no response headers in time

Output:
  --json                 exactly the SDK's returned value, as JSON
  --jsonl                one JSON object per line (streams and listings)
  --raw                  streams print each event's engine-native payload, not its AgentEvent
  --quiet                no informational notices on stderr
  --version              print the aw and contracts versions and exit

Exit codes: 0 ok, 1 the server refused (error: <code>: <message> on stderr; an unsupported
contracts version also names both versions and the fix), 2 usage,
3 the response broke the contract, 4 no response (network, timeout),
5 --strict found dropped fields (aw platforms), 130 interrupted.
`;

function line(command: Command): string {
  const path = command.path.join(' ');
  return `  aw ${path}${command.usage === '' ? '' : ` ${command.usage}`}\n      ${command.summary}`;
}

/** One command's own help: its usage line, which names its flags, and its summary (BH061-041). */
function commandHelp(command: Command): string {
  const path = command.path.join(' ');
  return `Usage: aw ${path}${command.usage === '' ? '' : ` ${command.usage}`} [flags]\n\n${command.summary}\n`;
}

/**
 * The whole tree, one family's part of it, or one command's own help (also when its arguments
 * follow, as in `aw runs get <id> --help`); `''` for words that name nothing.
 */
export function helpText(prefix: readonly string[]): string {
  const commands = commandsUnder(prefix);
  const resolved = resolveCommand(prefix);
  const leaf =
    prefix.length > 0 && commands.length <= 1 && resolved !== null ? resolved.command : null;
  if (commands.length === 0 && leaf === null) return '';
  const heading =
    leaf !== null
      ? commandHelp(leaf)
      : prefix.length === 0
        ? 'aw — the Agent Workspace command line\n\nUsage: aw <family> <command> [arguments] [flags]\n\nCommands:'
        : `Usage: aw ${prefix.join(' ')} <command> [arguments] [flags]\n\nCommands:`;
  const listing = leaf === null ? `\n${commands.map(line).join('\n')}\n` : '';
  // issue #689: `aw init` answers the setup questions, so its help lists them, generated.
  const setup =
    prefix[0] === 'init'
      ? `\nSetup flags (an answered question is not asked; --yes takes the default for the rest):\n${setupFlagsHelp().join('\n')}\n`
      : '';
  return `${heading}${listing}${setup}${GLOBAL_FLAGS}`;
}
