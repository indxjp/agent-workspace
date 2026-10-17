import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FieldVerdict, PlatformFile, PlatformId } from '@indx-workspace/contracts/platforms';
import {
  compileForPlatform,
  formatPlatformReport,
  PLATFORM_TARGETS,
  type PlatformTarget,
} from '@indx-workspace/platforms';

import type { LocalCommandContext } from '../command.js';
import { CommandRefusedError, UsageError } from '../io.js';
import { errorCode } from '../local-runtime/project.js';
import { escapes } from '../project/load.js';
import { loadPlatformProject, targetOptions } from './project.js';

export interface PlatformExport {
  readonly platform: PlatformId;
  readonly agent: string;
  /** Absolute. */
  readonly directory: string;
  /** Relative paths written, sorted. */
  readonly files: readonly string[];
  readonly report: readonly FieldVerdict[];
  readonly dropped: number;
  /** Present before, not produced now, not vendor state. Never removed. */
  readonly stale: readonly string[];
}

export const PLATFORM_REPORT_FILE = 'PLATFORM_REPORT.md';

/** What a vendor's own tool keeps in the export directory; it survives and is never called stale. */
const VENDOR_STATE: readonly RegExp[] = [
  /^claude-lock\.json$/u,
  /^agentcore\/\.cli\//u,
  /(?:^|\/)node_modules\//u,
  /(?:^|\/)\.git\//u,
];

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git']);
const TOOLS_DIRECTORY = 'tools';
const FIELD_PATH_MAX = 512;
const FIELD_NOTE_MAX = 1_024;

function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function unsafe(platform: string, file: string): CommandRefusedError {
  return new CommandRefusedError(`platform target ${platform} produced an unsafe path ${file}`);
}

/** The nearest ancestor of `target` (or `target` itself) that exists, resolved through links. */
async function nearestRealPath(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * The absolute destination of each of `files` under `directory`, every one proven to stay inside it
 * before the first byte is written: relative, no `..` segment, no drive letter, and the real path
 * of the nearest existing ancestor (a link included) inside the real `directory`, and no link at
 * the destination itself.
 */
export async function guardPaths(
  directory: string,
  platform: string,
  files: readonly string[],
): Promise<readonly string[]> {
  const absolute = files.map((file) => {
    const segments = file.split(/[\\/]/u);
    if (
      file === '' ||
      /^[\\/]/u.test(file) ||
      /^[A-Za-z]:/u.test(file) ||
      segments.some((segment) => segment === '..' || segment === '' || segment.includes('\0'))
    ) {
      throw unsafe(platform, file);
    }
    const target = path.resolve(directory, ...segments);
    if (escapes(path.relative(directory, target))) throw unsafe(platform, file);
    return target;
  });
  await mkdir(directory, { recursive: true });
  const real = await realpath(directory);
  for (const [index, target] of absolute.entries()) {
    if (escapes(path.relative(real, await nearestRealPath(target)))) {
      throw unsafe(platform, files[index] ?? target);
    }
  }
  // A link at a destination would be followed by the write, dangling or not; refuse before any.
  for (const [index, target] of absolute.entries()) {
    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink() === true) throw unsafe(platform, files[index] ?? target);
  }
  return absolute;
}

/** Every regular file under `directory` as a sorted, `/`-separated path relative to it. */
async function filesUnder(directory: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(child);
      } else if (entry.isFile()) found.push(child);
    }
  };
  await walk('');
  return found.sort(byCodeUnit);
}

/** The project's `tools/` as files to copy into an eject export: regular files, no links. */
async function projectTools(root: string): Promise<readonly PlatformFile[]> {
  const copied: PlatformFile[] = [];
  for (const file of await filesUnder(path.join(root, TOOLS_DIRECTORY))) {
    const source = path.join(root, TOOLS_DIRECTORY, ...file.split('/'));
    copied.push({
      path: `${TOOLS_DIRECTORY}/${file}`,
      content: new Uint8Array(await readFile(source)),
    });
  }
  return copied;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export function platformTarget(id: string): PlatformTarget {
  const target = PLATFORM_TARGETS.find((candidate) => candidate.id === id);
  if (target === undefined) {
    throw new UsageError(
      `unknown agent platform ${JSON.stringify(id)}`,
      `one of: ${PLATFORM_TARGETS.map((candidate) => candidate.id).join(', ')}`,
    );
  }
  return target;
}

export function droppedCount(report: readonly FieldVerdict[]): number {
  return report.filter((entry) => entry.verdict === 'dropped').length;
}

/** The refusal text shared by export and doctor: `<code>: <message>`, then its details. */
export function refusalText(refusal: {
  readonly code: string;
  readonly message: string;
  readonly details: readonly string[];
}): string {
  return [`${refusal.code}: ${refusal.message}`, ...refusal.details.map((d) => `  ${d}`)].join(
    '\n',
  );
}

/**
 * Compiles the project's agent for one agent platform and writes its files and
 * `PLATFORM_REPORT.md` under `--out` (default `platforms/<id>/`). Nothing is ever deleted: vendor
 * state such as `claude-lock.json` must survive, and files this compile did not produce are only
 * reported as `stale`. An `eject-*` target also gets the project's `tools/` copied verbatim,
 * because a pure translator cannot carry the run files.
 */
export async function exportPlatform(
  context: LocalCommandContext,
  input: {
    readonly platform: string;
    readonly agent?: string | undefined;
    readonly environment?: string | undefined;
    readonly out?: string | undefined;
  },
): Promise<PlatformExport> {
  const target = platformTarget(input.platform);
  const loaded = await loadPlatformProject(context, {
    agent: input.agent,
    platform: target.id,
    environment: input.environment,
  });
  if (loaded.document.platforms?.[target.id]?.enabled === false) {
    throw new CommandRefusedError(
      `platforms.${target.id}.enabled is false in agent-workspace.yaml`,
      'set enabled: true',
    );
  }
  const { cwd } = context;
  if (cwd === undefined) throw new CommandRefusedError('there is no current directory to load');

  const compiled = compileForPlatform(
    target,
    loaded.project,
    targetOptions(target, loaded.options),
  );
  if (!compiled.ok) throw new CommandRefusedError(refusalText(compiled.refusal));

  const directory = path.resolve(cwd, input.out ?? path.join('platforms', target.id));
  const copied = target.id.startsWith('eject-') ? await projectTools(cwd) : [];
  const report: FieldVerdict[] = [
    ...compiled.report,
    ...loaded.dropped.map((drop): FieldVerdict => ({
      path: clip(drop.path, FIELD_PATH_MAX),
      verdict: 'dropped',
      code: 'field_unsupported',
      note: clip(drop.reason, FIELD_NOTE_MAX),
    })),
    ...(copied.length === 0
      ? []
      : [
          {
            path: TOOLS_DIRECTORY,
            verdict: 'native',
            note: `copied ${String(copied.length)} files from ${TOOLS_DIRECTORY}/`,
          } satisfies FieldVerdict,
        ]),
  ];
  const result: PlatformExport = {
    platform: target.id,
    agent: loaded.project.root,
    directory,
    files: [...compiled.files, ...copied, { path: PLATFORM_REPORT_FILE, content: '' }]
      .map((file) => file.path)
      .sort(byCodeUnit),
    report,
    dropped: droppedCount(report),
    stale: [],
  };
  const produced: readonly PlatformFile[] = [
    ...compiled.files,
    ...copied,
    { path: PLATFORM_REPORT_FILE, content: renderPlatformReport(result) },
  ];

  const targets = await guardPaths(
    directory,
    target.id,
    produced.map((file) => file.path),
  );
  const before = await filesUnder(directory);
  for (const [index, file] of produced.entries()) {
    const destination = targets[index];
    if (destination === undefined) continue;
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
  const written = new Set(result.files);
  return {
    ...result,
    stale: before.filter(
      (file) => !written.has(file) && !VENDOR_STATE.some((pattern) => pattern.test(file)),
    ),
  };
}

/** The text of `PLATFORM_REPORT.md`: deterministic, with no timestamp, version or absolute path. */
export function renderPlatformReport(result: PlatformExport): string {
  const displayName =
    PLATFORM_TARGETS.find((target) => target.id === result.platform)?.displayName ??
    result.platform;
  const table = formatPlatformReport(result.platform, result.report);
  return [
    `# Platform report: ${displayName}`,
    '',
    `Agent \`${result.agent}\` exported to \`${result.platform}\`.`,
    '',
    table.slice(table.indexOf('\n\n') + 2),
  ].join('\n');
}
