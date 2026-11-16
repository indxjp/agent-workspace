/**
 * `aw destroy <app|resource|agent|page|recipe|channel|blueprint> <name> [--yes]` (issues #1505,
 * #1507, #1514, #1519, ADR-0114 S2): removes exactly what one `aw generate` or `aw blueprint add`
 * (ADR-0166 D11, the one removal path of an app blueprint) wrote, as `aw-generated.json` records
 * it. It shows its plan and acts only with `--yes`; a file edited since it was generated, or an
 * edit it cannot undo, refuses the whole command before anything is removed. The `project:<name>`
 * entry `create --template` records (issue #1531) is refused by name: those files are the project
 * itself.
 */
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  GENERATED_ENTRY_KINDS,
  GENERATED_MANIFEST_FILE,
  generatedEntryKey,
  removeGeneratedEntry,
  type GeneratedEdit,
  type GeneratedEntry,
  revertGeneratedEdit,
  type GeneratedEditRevert,
  type GeneratedEntryKind,
} from '@indx-workspace/sdk/project';

import { isOn, type LocalCommandContext } from '../command.js';
import { CommandRefusedError, UsageError, type CliIo } from '../io.js';
import { readManifest, writeManifest } from './manifest.js';
import {
  readTextIfPresent,
  recordedFileState,
  removeEmptyParents,
  type RecordedFileState,
} from './write.js';

interface PlannedFile {
  readonly path: string;
  readonly state: RecordedFileState;
}

interface PlannedEdit {
  readonly edit: GeneratedEdit;
  readonly outcome: GeneratedEditRevert;
}

interface DestroyPlan {
  readonly files: readonly PlannedFile[];
  readonly edits: readonly PlannedEdit[];
  /** The text each edited file is written back with, once every edit of it is reverted. */
  readonly reverted: ReadonlyMap<string, string>;
}

/** The kind `create --template` records the project's own files under; never destroyed. */
const PROJECT_KIND: GeneratedEntryKind = 'project';

/** The kinds `aw destroy` removes: every recorded kind but the project's own files. */
const DESTROYABLE_KINDS = GENERATED_ENTRY_KINDS.filter((kind) => kind !== PROJECT_KIND);

function kindOf(word: string | undefined): GeneratedEntryKind {
  if (word === PROJECT_KIND) {
    throw new CommandRefusedError(
      "the project's own files are not destroyed (package.json, agent-workspace.yaml and the rest create wrote); remove the directory instead",
    );
  }
  const kind = DESTROYABLE_KINDS.find((candidate) => candidate === word);
  if (kind === undefined) {
    throw new UsageError(
      `aw destroy needs a kind, one of ${DESTROYABLE_KINDS.join(', ')}`,
      'aw destroy resource <name>',
    );
  }
  return kind;
}

/** Reverts the edits file by file, in the order they were recorded. */
async function planEdits(
  cwd: string,
  edits: readonly GeneratedEdit[],
): Promise<Pick<DestroyPlan, 'edits' | 'reverted'>> {
  const texts = new Map<string, string | undefined>();
  const planned: PlannedEdit[] = [];
  const reverted = new Map<string, string>();
  for (const edit of edits) {
    if (!texts.has(edit.path)) texts.set(edit.path, await readTextIfPresent(cwd, edit.path));
    const text = texts.get(edit.path);
    const outcome: GeneratedEditRevert =
      text === undefined ? { kind: 'absent' } : revertGeneratedEdit(text, edit);
    if (outcome.kind === 'reverted') {
      texts.set(edit.path, outcome.text);
      reverted.set(edit.path, outcome.text);
    }
    planned.push({ edit, outcome });
  }
  return { edits: planned, reverted };
}

async function planDestroy(cwd: string, entry: GeneratedEntry): Promise<DestroyPlan> {
  const files: PlannedFile[] = [];
  for (const [file, sha256] of Object.entries(entry.files)) {
    files.push({ path: file, state: await recordedFileState(cwd, file, sha256) });
  }
  return { files, ...(await planEdits(cwd, entry.edits)) };
}

/** Every reason the plan cannot be carried out, all at once. */
function refuseUnsafe(command: string, plan: DestroyPlan): void {
  const edited = plan.files.filter((file) => file.state === 'edited').map((file) => file.path);
  if (edited.length > 0) {
    throw new CommandRefusedError(
      `${command} would remove files edited since they were generated:\n${edited.map((file) => `  ${file}`).join('\n')}`,
      `restore them with git checkout -- ${edited.join(' ')}, or remove them yourself`,
    );
  }
  const refused = plan.edits.flatMap(({ edit, outcome }) =>
    outcome.kind === 'refused' ? [`  ${edit.path} ${outcome.reason}`] : [],
  );
  if (refused.length > 0) {
    throw new CommandRefusedError(`${command} cannot undo its edits:\n${refused.join('\n')}`);
  }
}

function planLines(plan: DestroyPlan): string {
  const files = plan.files.map((file) =>
    file.state === 'missing' ? `  missing   ${file.path}\n` : `  unchanged ${file.path}\n`,
  );
  const edits = plan.edits.map(({ edit, outcome }) =>
    outcome.kind === 'reverted'
      ? `  revert    ${edit.path}: ${edit.added.trim()}\n`
      : `  gone      ${edit.path}: ${edit.added.trim()} (no longer there; left as is)\n`,
  );
  return [...files, ...edits].join('');
}

async function carryOut(cwd: string, plan: DestroyPlan, io: CliIo): Promise<void> {
  for (const file of plan.files) {
    if (file.state !== 'unchanged') continue;
    await rm(path.join(cwd, file.path));
    await removeEmptyParents(cwd, file.path);
    io.stdout(`removed ${file.path}\n`);
  }
  for (const [file, text] of plan.reverted) {
    await writeFile(path.join(cwd, file), text);
    io.stdout(`reverted ${file}\n`);
  }
}

export async function runDestroy(context: LocalCommandContext): Promise<void> {
  const { io, cwd, positionals } = context;
  if (cwd === undefined) throw new CommandRefusedError('aw destroy needs a current directory');
  const [word, name, ...extra] = positionals;
  const kind = kindOf(word);
  if (name === undefined || name.trim() === '' || extra.length > 0) {
    throw new UsageError(`aw destroy ${kind} takes one <name>`);
  }
  const command = `aw destroy ${kind} ${name}`;
  const manifest = await readManifest(cwd);
  const key = generatedEntryKey(kind, name);
  const entry = Object.hasOwn(manifest.entries, key) ? manifest.entries[key] : undefined;
  if (entry === undefined) {
    throw new CommandRefusedError(
      `${GENERATED_MANIFEST_FILE} records no ${kind} named ${name}, so aw destroy removes nothing`,
    );
  }
  const others = Object.keys(manifest.entries).filter(
    (other) => !other.startsWith('app:') && !other.startsWith(`${PROJECT_KIND}:`),
  );
  if (kind === 'app' && others.length > 0) {
    throw new CommandRefusedError(
      `the app still has ${others.join(', ')}; destroy them first`,
      `aw destroy ${others[0]?.replace(':', ' ') ?? ''}`,
    );
  }
  const plan = await planDestroy(cwd, entry);
  refuseUnsafe(command, plan);
  io.stdout(`${command} ${isOn(context, 'yes') ? 'removes' : 'would remove'}:\n${planLines(plan)}`);
  if (!isOn(context, 'yes')) {
    io.stderr(`nothing removed; run ${command} --yes to remove it\n`);
    return;
  }
  await carryOut(cwd, plan, io);
  const rest = removeGeneratedEntry(manifest, key);
  await writeManifest(cwd, rest);
  const emptied = Object.keys(rest.entries).length === 0;
  io.stdout(`${emptied ? 'removed' : 'updated'} ${GENERATED_MANIFEST_FILE}\n`);
}
