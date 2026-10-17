import { command, isOn, value, type ApiCommand, type CommandContext } from '../command.js';
import { CommandRefusedError } from '../io.js';
import { projectSecretNames, projectUrlOf, readLocalProject } from '../local-runtime/project.js';
import { notice, writeResult } from '../output.js';
import {
  formatProblem,
  planProject,
  problemCount,
  pushProject,
  resolveSummary,
  withMissingFolderHint,
  type AgentPlan,
  type BundleReport,
  type PlanReport,
  type PushedAgent,
  type PushReport,
} from '../project/index.js';

/** The project directory: the one `aw` runs in. */
export function projectRoot(context: CommandContext): string {
  const root = context.io.cwd;
  if (root === undefined) throw new CommandRefusedError('there is no current directory to load');
  return root;
}

/**
 * What `aw check` and `aw push` take from `agent-workspace.yaml`, when there is one: the engine an
 * agent that names none runs on (C12), and the secret names kept out of the loader (SD17). A file
 * the schema refuses is a usage error at its line and column.
 */
export async function projectOptions(root: string) {
  const read = await readLocalProject(root);
  return {
    read,
    options: {
      defaultEngine: read?.lifted === false ? read.project.engine : undefined,
      withheld: read === null ? [] : projectSecretNames(read),
    },
  };
}

/** The `skills` key of a JSON report, left out when the project has no `skills/` to say. */
function skillsField(skills: PlanReport['skills']): { skills?: PlanReport['skills'] } {
  return skills.skills.length + skills.workspaceOnly.length === 0 ? {} : { skills };
}

/** The `bundles` key of a JSON report, left out when the project has no code tool to bundle. */
function bundlesField(bundles: readonly BundleReport[]): { bundles?: readonly BundleReport[] } {
  return bundles.length === 0 ? {} : { bundles };
}

/** One line per code tool's bundle: stored already, to be uploaded, or (with `--yes`) uploaded. */
function bundleLine(bundle: BundleReport): string {
  const where = `${bundle.file}: tool bundle ${JSON.stringify(bundle.tool)} (${String(bundle.bytes)} bytes, sha256 ${bundle.digest})`;
  if (bundle.action === 'unchanged') return `${where} is already uploaded`;
  return bundle.saved ? `${where} uploaded` : `${where} would be uploaded`;
}

function machineReadable(context: CommandContext): boolean {
  return context.mode.json || context.mode.jsonl;
}

/** Print the problems, and refuse with their count; exit 1. */
function refuseWith(
  context: CommandContext,
  report: { readonly problems: PlanReport['problems'] },
): void {
  if (report.problems.length === 0) return;
  if (!machineReadable(context)) {
    for (const problem of report.problems) context.io.stdout(`${formatProblem(problem)}\n`);
  }
  throw new CommandRefusedError(problemCount(report.problems.length));
}

/**
 * The one line `aw check` prints for an agent that passed: what a push would do, from the same
 * plan `aw push` applies (issue #559).
 */
function checkLine(agent: AgentPlan): string {
  const version = String(agent.version);
  switch (agent.action) {
    case 'create':
    case 'version':
      return `${agent.file}: ok (would be version ${version})`;
    case 'none':
      return `${agent.file}: ok (unchanged, local ${version})`;
    case 'point': {
      if (agent.local.from === agent.local.to) {
        return `${agent.file}: ok (edited outside aw push; version ${version} would be applied again)`;
      }
      const from = agent.local.from === null ? 'none' : String(agent.local.from);
      return `${agent.file}: ok (version ${version} already holds this definition; local would move from ${from} to ${version})`;
    }
    default: {
      const unreachable: never = agent;
      return String(unreachable);
    }
  }
}

async function runCheck(context: CommandContext): Promise<undefined> {
  const root = projectRoot(context);
  const { options } = await projectOptions(root);
  const report = await planProject({
    client: context.client,
    root,
    io: context.io,
    signal: context.signal,
    ...options,
  });
  if (machineReadable(context)) {
    writeResult(context.io, context.mode, {
      ok: report.ok,
      problems: report.problems,
      ...skillsField(report.skills),
      tools: report.tools,
      ...bundlesField(report.bundles),
      agents: report.agents.map(({ file, name, agentId, action, version, local }) => ({
        file,
        name,
        agentId,
        action,
        version,
        local,
      })),
    });
  } else {
    for (const tool of report.tools) {
      context.io.stdout(`${tool.file}: ${tool.name} (${tool.kind}) ok\n`);
    }
    for (const skill of report.skills.skills) {
      const verb = skill.action === 'unchanged' ? 'ok' : `ok (would be ${skill.action}d)`;
      context.io.stdout(`skills/${skill.name}: ${verb}\n`);
    }
    for (const name of report.skills.workspaceOnly) {
      context.io.stdout(
        `skills/${name}: only in the workspace (no folder; aw does not delete it)\n`,
      );
    }
    for (const bundle of report.bundles) context.io.stdout(`${bundleLine(bundle)}\n`);
    for (const agent of report.agents) {
      context.io.stdout(`${checkLine(agent)}\n`);
    }
  }
  refuseWith(context, report);
  return undefined;
}

function pointerMove(agent: PushedAgent): string {
  const from = agent.local.from === null ? 'none' : String(agent.local.from);
  return `local ${from} → ${String(agent.local.to)}`;
}

/** The one line that says what a push does, or did, for an agent. */
function planLine(agent: PushedAgent): string {
  const name = JSON.stringify(agent.name);
  switch (agent.action) {
    case 'create':
      return `${agent.file}: create ${name} at version ${String(agent.version)} (${pointerMove(agent)})`;
    case 'version':
      return `${agent.file}: version ${String(agent.version)} of ${name} (${pointerMove(agent)})`;
    case 'point':
      if (agent.local.from === agent.local.to) {
        return `${agent.file}: ${name} was edited outside aw push; version ${String(agent.version)} is applied again (${pointerMove(agent)})`;
      }
      return `${agent.file}: version ${String(agent.version)} of ${name} already holds this definition (${pointerMove(agent)})`;
    case 'none':
      return `${agent.file}: ${name} is unchanged (local ${String(agent.version)})`;
    default: {
      const unreachable: never = agent.action;
      return String(unreachable);
    }
  }
}

function writePushReport(context: CommandContext, report: PushReport): void {
  if (machineReadable(context)) {
    writeResult(context.io, context.mode, {
      saved: report.saved,
      problems: report.problems,
      ...skillsField(report.skills),
      ...(report.tools.length === 0 ? {} : { tools: report.tools }),
      ...bundlesField(report.bundles),
      agents: report.agents,
    });
    return;
  }
  for (const skill of report.skills.skills) {
    if (skill.action !== 'unchanged') {
      context.io.stdout(`skills/${skill.name}: ${skill.action} (${String(skill.files)} files)\n`);
    }
  }
  for (const tool of report.tools) {
    if (tool.action !== 'unchanged') {
      context.io.stdout(`${tool.file}: ${tool.action} tool ${JSON.stringify(tool.name)}\n`);
    }
  }
  for (const bundle of report.bundles) context.io.stdout(`${bundleLine(bundle)}\n`);
  for (const agent of report.agents) {
    context.io.stdout(`${planLine(agent)}\n`);
    for (const change of agent.changes) context.io.stdout(`  ${change.op} ${change.path}\n`);
  }
}

async function runPush(context: CommandContext): Promise<undefined> {
  const yes = isOn(context, 'yes');
  const summary = resolveSummary(value(context, 'summary'));
  const root = projectRoot(context);
  const { read, options } = await projectOptions(root);
  const report = await pushProject({
    client: context.client,
    root,
    io: context.io,
    signal: context.signal,
    summary,
    yes,
    project: read?.lifted === false ? read.project : undefined,
    ...options,
  });
  // SD7: only `aw dev` applies them, from the developer's own environment.
  if (
    read?.lifted === false &&
    (read.project.models !== undefined || read.project.connectors !== undefined) &&
    // Origins, so `http://127.0.0.1:3000/` is the project's own runtime too.
    (URL.canParse(context.baseUrl) ? new URL(context.baseUrl).origin : context.baseUrl) !==
      projectUrlOf(read)
  ) {
    notice(context.io, context.mode, 'models and connectors are applied by aw dev only');
  }
  writePushReport(context, report);
  // The hint goes to the printed lines only: `refuseWith` prints nothing with --json.
  refuseWith(context, { problems: report.problems.map(withMissingFolderHint) });
  if (!yes) notice(context.io, context.mode, 'nothing was saved: run aw push --yes to save');
  return undefined;
}

/**
 * Issue #452 (S1-14): agents as code. `aw check` dry-runs the project's `agents/*.ts` and
 * `surfaces/*.ts` against the server's save pipeline; `aw push` shows what would change and, with
 * `--yes` only, saves a version per agent and points `local` at it. Both read the current
 * directory; the files are loaded as ADR-0111 records.
 */
export const projectFileCommands: readonly ApiCommand[] = [
  command(
    'check',
    '',
    "Check this project's agents and surfaces against the server, saving nothing",
    runCheck,
  ),
  command(
    'push',
    '[--yes] [--summary <text>]',
    "Show what this project's agents and surfaces would change; with --yes, save a version and point local at it",
    runPush,
  ),
];
