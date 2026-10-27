/**
 * The command tree — every ✅ row of `docs/sdk/04-api-specification.md` §5, and nothing else.
 * A row that waits for a server change has no command here rather than a stub, so `aw --help`
 * is an honest inventory of what the control plane can do today.
 *
 * The local commands (`aw init`, `aw dev`, `aw tool call`; issues #451 and #800, ADR-0109) are the
 * exception: they need no control plane, so they are not §5 rows. They work on the current
 * directory and the local runtime the project installs.
 *
 * `aw check` and `aw push` (issue #452, ADR-0111) sit beside them: they load the project's
 * `agents/*.ts` and `surfaces/*.ts` from the current directory, then check or save them as agent
 * versions through the control plane. The raw version commands (`aw agents versions …`,
 * `aw agents pointers set`) follow the agent commands.
 */
import type { Command } from '../command.js';
import { agentVersionCommands } from './agent-versions.js';
import { agentNewCommands } from './agents-new.js';
import { agentCommands } from './agents.js';
import { authCommands } from './auth.js';
import { chatCommands } from './chat.js';
import { connectorCommands } from './connectors.js';
import { deployCommands } from './deploy.js';
import { devCommands } from './dev.js';
import { platformCommands } from './platforms.js';
import { endpointClientCommands } from './endpoint-clients.js';
import { engineCommands } from './engines.js';
import { evalCommands } from './eval.js';
import { feedbackCommands } from './feedback.js';
import { fileCommands } from './files.js';
import { initCommands } from './init.js';
import { meCommands } from './me.js';
import { modelCommands } from './models.js';
import { observabilityCommands } from './observability.js';
import { projectFileCommands } from './project.js';
import { projectCommands } from './projects.js';
import { releaseCommands } from './release.js';
import { runCommands } from './runs.js';
import { runtimeCommands } from './runtimes.js';
import { secretCommands } from './secrets.js';
import { sessionCommands } from './sessions.js';
import { shareCommands } from './shares.js';
import { skillCommands } from './skills.js';
import { storageCommands } from './storage.js';
import { teamCommands } from './team.js';
import { toolCommands } from './tool.js';
import { tokenCommands } from './tokens.js';
import { triggerCommands } from './triggers.js';
import { workspaceCommands } from './workspaces.js';

export const COMMANDS: readonly Command[] = [
  // Issue #451 (S1-13): the local commands a new project starts with, before any control plane.
  ...initCommands,
  ...devCommands,
  // Issue #800: run one code tool through the local tool host, without a chat turn.
  ...toolCommands,
  // Issue #452 (S1-14): check and push the project's agents and surfaces as versions.
  ...projectFileCommands,
  // Issue #618: score a version against the project's evals/<agent>.yaml.
  ...evalCommands,
  // Issue #615: promote to production, roll it back, and show the pointers and their moves.
  ...releaseCommands,
  // Issue #621: deploy the project's production environment through `agent-workspace deploy`.
  ...deployCommands,
  // Platform targets (ADR-0133): export an agent to another agent platform.
  ...platformCommands,
  // Issue #620: the ratings a thumbs-down case is made from.
  ...feedbackCommands,
  // Issue #697 (FH-10): talk to an agent from the terminal.
  ...chatCommands,
  // First, as `docs/sdk/04-api-specification.md` §7.2's tree prints it: the call that tells a
  // freshly configured CLI which workspace and role its credential resolved to.
  ...meCommands,
  // Issue #242 (SDK-10, S-22): signing a person in, before the commands only a person may run.
  ...authCommands,
  ...workspaceCommands,
  ...teamCommands,
  // Issue #949 (ADR-0134): the clients external platforms are bound to, and their keys.
  ...endpointClientCommands,
  // Issue #1295 (ADR-0144): the triggers that start a run from a webhook URL.
  ...triggerCommands,
  ...modelCommands,
  ...runtimeCommands,
  ...secretCommands,
  ...fileCommands,
  // Issue #1692 (US-STO-12): connect a bucket or folder and list it.
  ...storageCommands,
  ...skillCommands,
  ...connectorCommands,
  ...engineCommands,
  ...agentCommands,
  // Issue #1850: build an agent with the Builder, on a terminal.
  ...agentNewCommands,
  // Issue #452 (S1-14): the raw version and pointer commands.
  ...agentVersionCommands,
  ...projectCommands,
  ...sessionCommands,
  ...runCommands,
  ...shareCommands,
  ...observabilityCommands,
  ...tokenCommands,
];

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= words.length && prefix.every((word, index) => words[index] === word);
}

/** The command whose path is the longest prefix of the words, with the words that remain. */
export function resolveCommand(
  words: readonly string[],
): { readonly command: Command; readonly rest: readonly string[] } | null {
  let best: Command | null = null;
  for (const candidate of COMMANDS) {
    if (
      startsWith(words, candidate.path) &&
      (best === null || candidate.path.length > best.path.length)
    ) {
      best = candidate;
    }
  }
  return best === null ? null : { command: best, rest: words.slice(best.path.length) };
}

/** The commands under a prefix (every command for an empty one), or none for an unknown prefix. */
export function commandsUnder(prefix: readonly string[]): readonly Command[] {
  return COMMANDS.filter((candidate) => startsWith(candidate.path, prefix));
}
