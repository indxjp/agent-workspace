import type { AgentPointerMoveResponse } from '@indx-workspace/contracts/agent-versions';
import { ApiProblemError } from '@indx-workspace/sdk';

import { command, isOn, type ApiCommand, type CommandContext } from '../command.js';
import { projectUrl } from '../config.js';
import { CommandRefusedError, UsageError } from '../io.js';
import { readLocalProject } from '../local-runtime/project.js';
import { notice } from '../output.js';
import { loadProject } from '../project/index.js';
import { renderVersions, versionNumberOf } from './agent-versions.js';
import { agentIdNamed } from './eval.js';
import { projectOptions, projectRoot } from './project.js';

/**
 * `[agent]`, else the one agent the project in the current directory defines. A blank name is
 * refused, and so is `aw promote 7` (`promote` is set for it, as it also takes `[version]`)
 * instead of looking up an agent named "7".
 */
async function agentNameOf(context: CommandContext, promote = false): Promise<string> {
  const [given, version] = context.positionals;
  if (given?.trim() === '') throw new UsageError('<agent> must not be empty');
  if (promote && given !== undefined && version === undefined && /^\d+$/u.test(given)) {
    throw new UsageError(`name the agent before [version]: aw promote <agent> ${given}`);
  }
  if (given !== undefined) return given;
  const root = projectRoot(context);
  const { options } = await projectOptions(root);
  const load = await loadProject({ root, io: context.io, signal: context.signal, ...options });
  const names = load.agents.map((agent) => agent.name);
  const [only] = names;
  if (only === undefined || names.length > 1) {
    throw new UsageError(
      'missing <agent>: name the agent to move' +
        (names.length > 1 ? ` (the project defines ${names.join(', ')})` : ''),
    );
  }
  return only;
}

/** `production: 6 -> 7`, and how to apply it when it was only checked. */
function writeMove(context: CommandContext, move: AgentPointerMoveResponse): undefined {
  const from = move.from === null ? 'none' : String(move.from);
  const hint = move.saved ? '' : '; pass --yes to move it';
  context.io.stdout(`${move.environment}: ${from} -> ${String(move.to)}${hint}\n`);
  return undefined;
}

/**
 * Issue #734: the promotion bar `agent-workspace.yaml` sets (`null` for none) when `aw promote`
 * targets the `aw dev` of the project in the current directory; `undefined` for any other target,
 * whose bar this file does not describe. The server keeps the gate: this only refuses a move whose
 * bar is not the file's, because `aw dev` reads the policy at start and was not restarted.
 */
async function projectBar(context: CommandContext): Promise<number | null | undefined> {
  const { cwd } = context.io;
  if (cwd === undefined) return undefined;
  const read = await readLocalProject(cwd);
  if (read === null || read.lifted || (await projectUrl(cwd)) !== context.baseUrl) return undefined;
  return read.project.policy?.promotion?.minEvalScore ?? null;
}

/** `bar 0.90`, or `no bar`. */
function barText(bar: number | null): string {
  return bar === null ? 'no bar' : `bar ${bar.toFixed(2)}`;
}

/** The failing cases a gate refusal names before it elides the rest with `…`. */
const FAILING_CASES_SHOWN = 3;

/**
 * Issue #619: the promotion gate's refusal of `agent`'s version, read from the problem's details
 * (`version:`, `score:`, `bar:`, `case:`), as the line `aw promote` prints and the command that
 * scores the version again; `null` for any other failure.
 */
export function promotionRefusalText(
  error: unknown,
  agent: string,
): { readonly message: string; readonly fix: string } | null {
  if (!(error instanceof ApiProblemError)) return null;
  const valuesOf = (prefix: string): string[] =>
    error.details.filter((detail) => detail.startsWith(prefix)).map((d) => d.slice(prefix.length));
  const [version] = valuesOf('version:');
  const [bar] = valuesOf('bar:');
  if (version === undefined || bar === undefined) return null;
  const twoPlaces = (value: string | undefined): string => Number(value).toFixed(2);
  let reason: string;
  if (error.code === 'promotion_not_evaluated') {
    reason = `v${version} has no evaluation (bar ${twoPlaces(bar)})`;
  } else if (error.code === 'promotion_gate_failed') {
    const cases = valuesOf('case:');
    const shown = cases.slice(0, FAILING_CASES_SHOWN).map((name) => JSON.stringify(name));
    if (cases.length > FAILING_CASES_SHOWN) shown.push('…');
    // Rounded down so a refused score never prints at or above the bar (0.8999 is `0.89`, not
    // `0.90`); the score is first snapped to its stored four places so `0.57` stays `0.57`.
    const score = Math.floor(Math.round(Number(valuesOf('score:')[0]) * 10_000) / 100) / 100;
    reason =
      `v${version} scored ${score.toFixed(2)} (bar ${twoPlaces(bar)}). ` +
      `Failing cases: ${shown.join(', ')}`;
  } else {
    return null;
  }
  const name = /^[\w.-]+$/u.test(agent) ? agent : JSON.stringify(agent);
  return {
    message: `production refused: ${reason}`,
    fix: `run \`aw eval ${name} ${version}\` after fixing, then promote again`,
  };
}

/**
 * ADR-0118 TS8: the server refuses a version that lists the tool host's connector where the
 * deployment has no tool sandbox, or the version pins no bundle one can serve. It cannot name the
 * tools, so this reads the promoted agent's from the project in the current directory.
 */
async function codeToolRefusal(
  context: CommandContext,
  error: unknown,
  agent: string,
): Promise<CommandRefusedError | null> {
  if (!(error instanceof ApiProblemError) || error.code !== 'code_tool_needs_host') return null;
  let names: string[] = [];
  try {
    const root = projectRoot(context);
    const { options } = await projectOptions(root);
    const load = await loadProject({ root, io: context.io, signal: context.signal, ...options });
    names = (load.agents.find((loaded) => loaded.name === agent)?.codeTools ?? []).map(
      (tool) => tool.name,
    );
  } catch {
    // No project here: the refusal still stands, only without the names.
  }
  const which = names.length === 0 ? 'code tools' : `the code tool ${names.join(', ')}`;
  return new CommandRefusedError(
    `production refused: this version uses ${which}, which this deployment cannot run`,
    'ask the operator to enable the tool sandbox (AGENT_WORKSPACE_TOOL_HOST_IMAGE), or push again with aw push so every code tool is bundled',
  );
}

/**
 * Issue #615: `aw promote` points `production` at the version `local` points at (or `[version]`),
 * `aw rollback` points `production` back at its previous version, and `aw versions` shows the
 * pointers and their last moves. Both moves show the server's dry run first and move only with
 * `--yes` (plan rule 8). The agent is named, or is the project's only one. Promote and rollback
 * always target `production`, so neither takes an environment.
 */
export const releaseCommands: readonly ApiCommand[] = [
  command(
    'promote',
    '[agent] [version] [--yes]',
    "Show production moving to local's version (or [version]), and move it with --yes",
    async (context) => {
      if (context.positionals.length > 2) {
        throw new UsageError('aw promote takes one [agent] and one [version]');
      }
      const name = await agentNameOf(context, true);
      const agentId = await agentIdNamed(context, name);
      const request =
        context.positionals[1] === undefined ? {} : { version: versionNumberOf(context, 1) };
      const options = { signal: context.signal };
      const refused = async (error: unknown): Promise<never> => {
        const refusal = promotionRefusalText(error, name);
        if (refusal !== null) throw new CommandRefusedError(refusal.message, refusal.fix);
        throw (await codeToolRefusal(context, error, name)) ?? error;
      };
      const fileBar = await projectBar(context);
      // With the project's own `aw dev` as the target, the dry run comes first, so a bar the
      // running server does not share with the file moves nothing.
      const yes = isOn(context, 'yes');
      let move = await (
        yes && fileBar === undefined
          ? context.client.agents.pointers.promote(agentId, request, options)
          : context.client.agents.pointers.checkPromote(agentId, request, options)
      ).catch(refused);
      if (fileBar !== undefined && fileBar !== move.bar) {
        throw new CommandRefusedError(
          `agent-workspace.yaml sets ${barText(fileBar)}, but the running aw dev has ${barText(move.bar)}; production was not moved`,
          'restart aw dev to apply agent-workspace.yaml, then run aw promote again',
        );
      }
      if (yes && fileBar !== undefined) {
        move = await context.client.agents.pointers
          .promote(agentId, request, options)
          .catch(refused);
      }
      if (context.mode.json || context.mode.jsonl) return { value: move };
      if (move.bar === null) {
        notice(context.io, context.mode, 'no promotion bar is set; production needs no evaluation');
      }
      return writeMove(context, move);
    },
  ),
  command(
    'rollback',
    '[agent] [--yes]',
    'Show production moving back to its previous version, and move it with --yes',
    async (context) => {
      if (context.positionals.length > 1) throw new UsageError('aw rollback takes one [agent]');
      const agentId = await agentIdNamed(context, await agentNameOf(context));
      const options = { signal: context.signal };
      const move = isOn(context, 'yes')
        ? await context.client.agents.pointers.rollback(agentId, {}, options)
        : await context.client.agents.pointers.checkRollback(agentId, {}, options);
      if (context.mode.json || context.mode.jsonl) return { value: move };
      return writeMove(context, move);
    },
  ),
  command(
    'versions',
    '[agent]',
    "An agent's versions, which version each environment runs, and the last pointer moves",
    async (context) => {
      if (context.positionals.length > 1) throw new UsageError('aw versions takes one [agent]');
      const agentId = await agentIdNamed(context, await agentNameOf(context));
      const list = await context.client.agents.versions.list(agentId, { signal: context.signal });
      if (context.mode.json || context.mode.jsonl) return { value: list };
      context.io.stdout(`${renderVersions(list)}\n`);
      return undefined;
    },
  ),
];
