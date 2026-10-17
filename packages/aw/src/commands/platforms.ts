import path from 'node:path';

import { compileForPlatform, PLATFORM_TARGETS } from '@indx-workspace/platforms';
import { PROJECT_FILE_NAME } from '@indx-workspace/sdk/project';

import { loadPublishSteps } from '../cli-bridge.js';
import {
  command,
  isOn,
  singleValue,
  type LocalCommand,
  type LocalCommandContext,
} from '../command.js';
import {
  ChangesPendingError,
  CommandRefusedError,
  PlatformFieldsDroppedError,
  UsageError,
} from '../io.js';
import { notice, writeResult } from '../output.js';
import {
  droppedCount,
  exportPlatform,
  type PlatformExport,
  PLATFORM_REPORT_FILE,
  platformTarget,
} from '../platforms/export.js';
import { importPlatform } from '../platforms/import.js';
import { loadPlatformProject, targetOptions } from '../platforms/project.js';
import { projectOptions } from './project.js';

const VERDICT_COLUMNS = ['path', 'verdict', 'code', 'note'] as const;
const DOCTOR_COLUMNS = ['check', 'subject', 'status', 'detail'] as const;

function rejectPositionals(context: LocalCommandContext): void {
  const [extra] = context.positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument ${JSON.stringify(extra)}`);
}

function flagValue(context: LocalCommandContext, flag: 'platform' | 'env' | 'out' | 'from') {
  const given = context.args.values.get(flag);
  if (given !== undefined && given.trim() === '')
    throw new UsageError(`--${flag} must not be empty`);
  return given;
}

function requiredPlatform(context: LocalCommandContext, flag: 'platform' | 'from'): string {
  const given = flagValue(context, flag);
  if (given === undefined) {
    throw new UsageError(
      `missing --${flag} <id>`,
      `one of: ${PLATFORM_TARGETS.map((target) => target.id).join(', ')}`,
    );
  }
  return given;
}

function runList(context: LocalCommandContext): Promise<void> {
  rejectPositionals(context);
  notice(
    context.io,
    context.mode,
    'agent platforms (aw platforms …); runtime drivers are a separate list (aw runtimes)',
  );
  writeResult(
    context.io,
    context.mode,
    PLATFORM_TARGETS.map(({ id, displayName, docsUrl, capabilities }) => ({
      id,
      displayName,
      docsUrl,
      capabilities,
    })),
    ['id', 'displayName', 'docsUrl'],
  );
  return Promise.resolve();
}

/** Every path `aw` prints uses `/`, whatever the OS. */
export function toPosix(file: string, separator: string = path.sep): string {
  return file.split(separator).join('/');
}

/** Prints the verdict table and the written/stale notices, then enforces `--strict`; returns the directory as shown. */
function reportExport(
  context: LocalCommandContext,
  result: PlatformExport,
  options: { readonly table: boolean },
): string {
  const { io, mode, cwd } = context;
  if (options.table) {
    writeResult(io, mode, mode.json || mode.jsonl ? result : result.report, VERDICT_COLUMNS);
  }
  const shown = toPosix(path.relative(cwd ?? '', result.directory)) || '.';
  notice(io, mode, `wrote ${String(result.files.length)} files to ${shown}`);
  for (const file of result.stale) {
    notice(
      io,
      mode,
      `stale: ${shown}/${file} was not produced by this export and was left in place`,
    );
  }
  if (isOn(context, 'strict') && result.dropped > 0) {
    throw new PlatformFieldsDroppedError(
      `${String(result.dropped)} fields dropped for ${result.platform}; see ${shown}/${PLATFORM_REPORT_FILE}`,
    );
  }
  return shown;
}

async function runExport(context: LocalCommandContext): Promise<void> {
  rejectPositionals(context);
  const result = await exportPlatform(context, {
    platform: requiredPlatform(context, 'platform'),
    agent: singleValue(context, 'agent'),
    environment: flagValue(context, 'env'),
    out: flagValue(context, 'out'),
  });
  reportExport(context, result, { table: true });
}

/** The executors throw plain `Error`s (aw never imports the CLI's classes); `fix` rides along when set. */
function refusal(error: Error): CommandRefusedError {
  const fix = (error as { readonly fix?: unknown }).fix;
  return new CommandRefusedError(error.message, typeof fix === 'string' ? fix : undefined);
}

async function runPublish(context: LocalCommandContext): Promise<void> {
  rejectPositionals(context);
  const { io, mode, signal } = context;
  const apply = isOn(context, 'yes');
  if (apply && isOn(context, 'plan')) throw new UsageError('--plan and --yes contradict');
  const agent = singleValue(context, 'agent');
  const environment = flagValue(context, 'env');
  const exported = await exportPlatform(context, {
    platform: requiredPlatform(context, 'platform'),
    agent,
    environment,
    out: flagValue(context, 'out'),
  });
  const structured = mode.json || mode.jsonl;
  reportExport(context, exported, { table: !structured });

  const { options } = await loadPlatformProject(context, {
    platform: exported.platform,
    agent,
    environment,
  });
  const steps = await loadPublishSteps();
  let outcome;
  try {
    outcome = await steps.publishPlatform({
      platform: exported.platform,
      directory: exported.directory,
      agent: exported.agent,
      ...(environment === undefined ? {} : { environment }),
      settings: options,
      apply,
      experimental: isOn(context, 'experimental'),
      env: { ...io.env },
      signal,
      out: structured ? io.stderr : io.stdout,
      err: io.stderr,
    });
  } catch (error) {
    if (error instanceof Error) throw refusal(error);
    throw error;
  }
  if (outcome.changes && !outcome.applied) {
    if (!structured) for (const step of outcome.nextSteps) notice(io, mode, `next: ${step}`);
    throw new ChangesPendingError('changes are pending; re-run with --yes to publish them');
  }
  if (structured) {
    writeResult(io, mode, {
      ...exported,
      published: outcome.applied,
      nextSteps: outcome.nextSteps,
    });
    return;
  }
  notice(
    io,
    mode,
    outcome.applied
      ? `published ${exported.agent} to ${exported.platform}`
      : `nothing to publish: ${exported.platform} already matches ${exported.agent}`,
  );
  for (const step of outcome.nextSteps) notice(io, mode, `next: ${step}`);
}

async function runImport(context: LocalCommandContext): Promise<void> {
  const { io, mode } = context;
  const platform = requiredPlatform(context, 'from');
  const [given, ...extra] = context.positionals;
  if (given === undefined) throw new UsageError('missing <path>');
  if (extra.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
  const result = await importPlatform(context, {
    platform,
    given,
    overwrite: isOn(context, 'yes'),
  });
  writeResult(io, mode, mode.json || mode.jsonl ? result : result.report, VERDICT_COLUMNS);
  notice(io, mode, `wrote ${String(result.files.length)} files: ${result.files.join(', ')}`);
}

interface DoctorRow {
  readonly check: string;
  readonly subject: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail: string;
}

function row(check: string, subject: string, status: DoctorRow['status'], detail = ''): DoctorRow {
  return { check, subject, status, detail };
}

async function checkPlatform(context: LocalCommandContext, id: string): Promise<DoctorRow[]> {
  const target = platformTarget(id);
  try {
    const loaded = await loadPlatformProject(context, {
      platform: target.id,
      agent: singleValue(context, 'agent'),
    });
    const compiled = compileForPlatform(
      target,
      loaded.project,
      targetOptions(target, loaded.options),
    );
    if (!compiled.ok) {
      return [row('compile', id, 'fail', `${compiled.refusal.code}: ${compiled.refusal.message}`)];
    }
    const dropped = droppedCount(compiled.report) + loaded.dropped.length;
    const rows = [
      dropped === 0
        ? row('compile', id, 'pass')
        : row('compile', id, 'warn', `${String(dropped)} fields dropped`),
    ];
    const root = loaded.project.agents.find((agent) => agent.name === loaded.project.root);
    const codeTools = root?.tools.filter((tool) => tool.kind === 'code').length ?? 0;
    if (codeTools > 0 && loaded.project.toolEndpoint === undefined) {
      rows.push(
        row(
          'tool-endpoint',
          id,
          'warn',
          `${String(codeTools)} code tools would be dropped (code_tool_needs_public_mcp); set publicBaseUrl and toolAuth under platforms.${id}.options`,
        ),
      );
    }
    return rows;
  } catch (error) {
    if (error instanceof CommandRefusedError || error instanceof UsageError) {
      return [row('compile', id, 'fail', error.message.replaceAll('\n', ' '))];
    }
    throw error;
  }
}

/**
 * The vendor tool each publishable platform needs. A missing or old tool only warns: it blocks
 * `aw platforms publish`, not the export `doctor` is mostly asked about.
 */
async function checkPrerequisites(
  context: LocalCommandContext,
  ids: readonly string[],
): Promise<DoctorRow[]> {
  const known = PLATFORM_TARGETS.filter((target) => ids.includes(target.id));
  if (known.length === 0) return [];
  let steps;
  try {
    steps = await loadPublishSteps();
  } catch (error) {
    if (!(error instanceof CommandRefusedError)) throw error;
    return [
      row('prerequisite', '@indx-workspace/cli', 'warn', `${error.message}; ${error.fix ?? ''}`),
    ];
  }
  const rows: DoctorRow[] = [];
  for (const { id } of known) {
    for (const found of await steps.checkPublishPrerequisites({
      platform: id,
      env: { ...context.io.env },
    })) {
      rows.push(
        row(
          'prerequisite',
          `${found.platform}/${found.tool}`,
          found.status === 'pass' ? 'pass' : 'warn',
          found.detail,
        ),
      );
    }
  }
  return rows;
}

async function runDoctor(context: LocalCommandContext): Promise<void> {
  rejectPositionals(context);
  const { io, mode, cwd } = context;
  const only = flagValue(context, 'platform');
  if (only !== undefined) platformTarget(only);
  const read = cwd === undefined ? null : (await projectOptions(cwd)).read;
  const document = read === null || read.lifted ? undefined : read.project;
  const enabled = Object.entries(document?.platforms ?? {})
    .filter(([, entry]) => entry?.enabled === true)
    .map(([id]) => id)
    .sort();
  const ids = only === undefined ? enabled : [only];

  const rows: DoctorRow[] = [];
  if (ids.length === 0)
    rows.push(row('project', PROJECT_FILE_NAME, 'warn', 'no platforms enabled'));
  for (const id of ids) rows.push(...(await checkPlatform(context, id)));
  rows.push(...(await checkPrerequisites(context, ids)));
  writeResult(io, mode, rows, DOCTOR_COLUMNS);
  const failed = rows.filter((entry) => entry.status === 'fail').length;
  if (failed > 0) throw new CommandRefusedError(`${String(failed)} checks failed`);
}

export const platformCommands: readonly LocalCommand[] = [
  command(
    'platforms list',
    '[--json]',
    'Every agent platform an agent can be exported to, with what each supports',
    { controlPlane: 'none', run: runList },
  ),
  command(
    'platforms export',
    '--platform <id> [--agent <name>] [--env <name>] [--out <dir>] [--strict] [--json]',
    "Compile the project's agent into a platform's files, report what maps and what is dropped; --strict exits 5 when any field is dropped",
    { controlPlane: 'none', run: runExport },
  ),
  command(
    'platforms publish',
    '--platform <id> [--agent <name>] [--env <name>] [--out <dir>] [--plan | --yes] [--experimental] [--strict] [--json]',
    "Export the agent to a platform, show the vendor tool's plan, and publish it with --yes; a plan with changes exits 3",
    { controlPlane: 'none', run: runPublish },
  ),
  command(
    'platforms import',
    '--from <id> <path> [--yes] [--json]',
    "Turn a platform's agent files into agents/<name>.agent.md; --yes overwrites existing files",
    { controlPlane: 'none', run: runImport },
  ),
  command(
    'platforms doctor',
    '[--platform <id>] [--agent <name>] [--json]',
    'Check that each enabled platform compiles, and what it would drop',
    { controlPlane: 'none', run: runDoctor },
  ),
];
