/**
 * `aw blueprint add | list | diff | update` (ADR-0166 D6, D7, D11, issue #1533): app blueprints,
 * versioned npm releases of app parts that an app installs and then receives each new version of
 * as a proposal. Local commands with no control plane: the platform never sees a blueprint.
 *
 * - `add <npm-spec> [--yes]` fetches the package with `npm pack --ignore-scripts`, verifies its
 *   integrity, reads it, renders its parts through the one template renderer, and shows the plan:
 *   the source, each file, each `app.config.ts` and journal edit, each slot. It exits 3 without
 *   `--yes`, because installing third-party code is always reviewed first; with `--yes` it writes
 *   and records the `blueprint:<name>` entry in `aw-generated.json`.
 * - `update <name> [--to <version>] [--yes]` proposes the new version per file (`add`, `update`,
 *   `remove`, `conflict`) and exits 3 when there is any change. With `--yes` it applies what does
 *   not conflict and writes each conflict's new text beside it as `<file>.blueprint-<version>`;
 *   a file the developer edited is never touched.
 * - `diff <name> [--to <version>]` prints the same proposal as line diffs and writes nothing; it
 *   exits 3 when there is a change and 0 when there is none.
 * - `list` prints each installed blueprint's package, version and integrity.
 *
 * Removal is `aw destroy blueprint <name>` (D11). Every refusal comes before anything is written.
 * `aw` never imports the app kit: the installed `@indx-workspace/app` version is read from the
 * project's own `node_modules`.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  addGeneratedEntry,
  appConfigLines,
  appConfigRecipeLines,
  generatedEntryKey,
  GENERATED_MANIFEST_FILE,
  planBlueprintInstall,
  planBlueprintUpdate,
  ProjectRenderError,
  removeGeneratedEntry,
  renderAppSpec,
  renderTemplateDirectory,
  serializeGeneratedManifest,
  type BlueprintAppState,
  type BlueprintArchive,
  type BlueprintFile,
  type BlueprintFileChange,
  type BlueprintMigrationWrite,
  type BlueprintRelease,
  type BlueprintSlotStatus,
  type BlueprintUpdatePlan,
  type BlueprintWiring,
  type GeneratedEdit,
  type GeneratedEntry,
  type GeneratedManifest,
  type MigrationJournal,
  type MigrationJournalEntry,
} from '@indx-workspace/sdk/project';
import { z } from 'zod';

import { command, isOn, type LocalCommand, type LocalCommandContext } from '../command.js';
import {
  APP_CONFIG_FILE,
  JOURNAL_FILE,
  journalEdit,
  readJournal,
  revertEdit,
  serializeJournal,
  withAppConfigLines,
  type AppConfigList,
} from '../generate/edits.js';
import { cwdOf, generatedApp, type InPlaceEdit } from '../generate/generation.js';
import { readManifest, writeManifest } from '../generate/manifest.js';
import {
  conflicts,
  occupied,
  readTextIfPresent,
  recordedFileState,
  removeEmptyParents,
  sha256Of,
  writeNewFiles,
} from '../generate/write.js';
import { ChangesPendingError, CommandRefusedError, UsageError, type CliIo } from '../io.js';
import { lineDiff } from '../line-diff.js';
import { findPackageDirectory } from '../local-runtime/resolve.js';
import { errorCode, projectSecretNames, readLocalProject } from '../local-runtime/project.js';
import { writeResult } from '../output.js';
import {
  fetchBlueprint,
  unpackBlueprint,
  type BlueprintFetch,
  type FetchedBlueprint,
} from './blueprint-fetch.js';

const APP_KIT_PACKAGE = '@indx-workspace/app';
const MIGRATIONS_DIR = 'db/migrations';
const AGENTS_DIR = 'agents';
const BLUEPRINT_PREFIX = 'blueprint:';

/** The one field read from the app kit's `package.json`, which has many others. */
const AppKitVersionSchema = z.object({
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[0-9A-Za-z.+-]+$/u),
});

/** The installed `@indx-workspace/app` version, or `undefined` when the project has none. */
async function installedAppKitVersion(cwd: string): Promise<string | undefined> {
  const directory = await findPackageDirectory(cwd, APP_KIT_PACKAGE);
  if (directory === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = AppKitVersionSchema.safeParse(json);
  return parsed.success ? parsed.data.version : undefined;
}

/** The SDK's refusal of a blueprint, as the command's refusal, every reason listed. */
function refusedBlueprint<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ProjectRenderError) {
      const [subject] = error.message.split(' could not be rendered');
      const reasons = error.issues.map((issue) => `  ${issue.path}: ${issue.message}`);
      throw new CommandRefusedError(
        `${subject ?? 'the blueprint'} is refused:\n${reasons.join('\n')}`,
      );
    }
    throw error;
  }
}

/**
 * Renders the verified files through `renderTemplateDirectory` (ADR-0166 D6): each part with no
 * values, so a `{{key}}` in it is refused rather than substituted, and each migration with exactly
 * one value, `appSchema`, the schema `aw generate resource` qualifies tables with. The files are
 * extracted into a new temporary directory, removed whatever happens.
 */
async function renderRelease(
  archive: BlueprintArchive,
  appSchema: string,
): Promise<BlueprintFile[]> {
  const migrations = new Set(archive.manifest.migrations);
  const directory = await mkdtemp(path.join(tmpdir(), 'aw-blueprint-render-'));
  try {
    for (const file of archive.files) {
      const target = path.join(directory, migrations.has(file.path) ? 'm' : 'p', file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.contents, { flag: 'wx' });
    }
    const subject = `the blueprint ${archive.manifest.name}`;
    const root = (name: string): URL => pathToFileURL(`${path.join(directory, name)}${path.sep}`);
    const rendered = refusedBlueprint(() => [
      ...renderTemplateDirectory(root('p'), {}, subject, {
        optional: true,
        missingMessage: () => 'is a placeholder; a part is installed as it is, with no values',
      }),
      ...renderTemplateDirectory(root('m'), { appSchema }, subject, {
        optional: true,
        missingMessage: () => 'is not appSchema, the one value a migration is rendered with',
      }),
    ]);
    return rendered.map((file) => ({ ...file, sha256: sha256Of(file.contents) }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Fetches, verifies, reads and renders one version of a blueprint. */
async function fetchRelease(
  context: LocalCommandContext,
  fetch: BlueprintFetch,
  cwd: string,
  spec: string,
  appName: string,
  installed?: string,
): Promise<BlueprintRelease> {
  const fetched: FetchedBlueprint = await fetch(spec, {
    cwd,
    env: context.io.env,
    signal: context.signal,
  });
  if (installed !== undefined && fetched.package !== installed) {
    throw new CommandRefusedError(
      `npm resolved ${spec} to ${fetched.package}, but ${installed} is installed`,
    );
  }
  const archive = unpackBlueprint(fetched);
  if (archive.packageName !== fetched.package) {
    throw new CommandRefusedError(
      `the package npm fetched as ${fetched.package} names itself ${archive.packageName}`,
    );
  }
  const appSchema = refusedBlueprint(() => renderAppSpec(appName))['schema'] ?? '';
  return {
    manifest: archive.manifest,
    files: await renderRelease(archive, appSchema),
    source: { package: fetched.package, version: fetched.version, integrity: fetched.integrity },
  };
}

/**
 * The paths the planners need to see: each candidate that exists, and every file of the given
 * directories (the migrations directory, and the directories of the recorded files, where an
 * unmerged `<file>.blueprint-<version>` sidecar would be). The whole tree is never walked.
 */
async function existingPaths(
  cwd: string,
  candidates: readonly string[],
  directories: readonly string[],
): Promise<string[]> {
  const found = new Set<string>();
  for (const candidate of candidates) {
    if (await occupied(path.join(cwd, candidate))) found.add(candidate);
  }
  for (const directory of new Set(directories)) {
    let names: string[];
    try {
      names = await readdir(path.join(cwd, directory));
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') continue;
      throw error;
    }
    for (const name of names) found.add(directory === '.' ? name : `${directory}/${name}`);
  }
  return [...found].sort();
}

/** The agents the project defines: `agents/<name>.ts` and `agents/<name>.agent.md`. */
async function projectAgents(cwd: string): Promise<string[]> {
  const names = await existingPaths(cwd, [], [AGENTS_DIR]);
  return names.flatMap((name) => {
    const match = /^agents\/([^/]+?)(?:\.agent\.md|(?<!\.test)\.ts)$/u.exec(name);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

/** The journal, refused when it is missing or not one whose entries count up from 0. */
async function journalOf(cwd: string): Promise<MigrationJournal> {
  const journal = readJournal((await readTextIfPresent(cwd, JOURNAL_FILE)) ?? '');
  if (journal === undefined) {
    throw new CommandRefusedError(
      `${JOURNAL_FILE} is missing or is not a migration journal whose entries count up from 0`,
      `restore ${JOURNAL_FILE} from version control`,
    );
  }
  return journal;
}

async function appState(
  cwd: string,
  manifest: GeneratedManifest,
  candidates: readonly string[],
  recorded: readonly string[],
): Promise<BlueprintAppState> {
  const read = await readLocalProject(cwd);
  const project = read === null || read.lifted ? undefined : read.project;
  return {
    paths: await existingPaths(cwd, candidates, [
      MIGRATIONS_DIR,
      ...recorded.map((file) => path.posix.dirname(file)),
    ]),
    appKitVersion: await installedAppKitVersion(cwd),
    manifest,
    agents: await projectAgents(cwd),
    connectors: Object.keys(project?.connectors ?? {}),
    secrets: read === null ? [] : [...projectSecretNames(read)],
    nextMigrationIndex: (await journalOf(cwd)).entries.length,
  };
}

/** The in-place edits and recorded edits that wire a plan's parts and migrations in. */
interface Wiring {
  readonly inPlace: readonly InPlaceEdit[];
  readonly added: readonly GeneratedEdit[];
  readonly reverted: readonly GeneratedEdit[];
  /**
   * The installed edits that stay in `app.config.ts` but leave the entry: the wiring of a part the
   * developer edited and the new version drops, which is now theirs (ADR-0166 D7).
   */
  readonly kept: readonly GeneratedEdit[];
}

/** The installed `app.config.ts` edits that wire the parts named in `wiring`. */
function configEditsOf(
  wiring: BlueprintWiring,
  installed: readonly GeneratedEdit[],
): GeneratedEdit[] {
  return LISTS.flatMap(([key, , linesOf]) =>
    wiring[key].flatMap((name) => {
      const lines = linesOf(name);
      return [lines.import, lines.entry].flatMap((line) => {
        const edit = installed.find((each) => each.path === APP_CONFIG_FILE && each.added === line);
        return edit === undefined ? [] : [edit];
      });
    }),
  );
}

const LISTS: readonly (readonly [keyof BlueprintWiring, AppConfigList, typeof appConfigLines])[] = [
  ['resources', 'resources', appConfigLines],
  ['recipes', 'recipes', appConfigRecipeLines],
];

function configLinesAdded(config: string, wiring: BlueprintWiring, added: GeneratedEdit[]): string {
  let text = config;
  for (const [key, list, linesOf] of LISTS) {
    for (const name of wiring[key]) {
      const lines = linesOf(name);
      const next = withAppConfigLines(text, lines, list);
      if (next === undefined) {
        throw new CommandRefusedError(
          `${APP_CONFIG_FILE} has no ${list}: [ ... ] list on lines of its own to add ${name} to, or already imports it`,
          `add ${name} to ${APP_CONFIG_FILE} by hand`,
        );
      }
      text = next;
      added.push(
        { path: APP_CONFIG_FILE, added: lines.import },
        { path: APP_CONFIG_FILE, added: lines.entry },
      );
    }
  }
  return text;
}

function configLinesRemoved(
  config: string,
  wiring: BlueprintWiring,
  installed: readonly GeneratedEdit[],
  reverted: GeneratedEdit[],
): string {
  let text = config;
  for (const edit of configEditsOf(wiring, installed)) {
    const outcome = revertEdit(text, edit);
    if (outcome.kind === 'refused') {
      throw new CommandRefusedError(`${APP_CONFIG_FILE} ${outcome.reason}`);
    }
    if (outcome.kind === 'reverted') text = outcome.text;
    reverted.push(edit);
  }
  return text;
}

/** The journal entries of the new migrations, appended after the last. */
function journalWithMigrations(
  journal: MigrationJournal,
  migrations: readonly BlueprintMigrationWrite[],
  added: GeneratedEdit[],
): string {
  const entries: MigrationJournalEntry[] = [...journal.entries];
  for (const migration of migrations) {
    const last = entries.at(-1);
    const entry: MigrationJournalEntry = {
      idx: migration.idx,
      version: last?.version ?? '7',
      when: (last?.when ?? 0) + 1,
      tag: migration.tag,
      breakpoints: true,
    };
    entries.push(entry);
    added.push(journalEdit(entry));
  }
  return serializeJournal({ ...journal, entries });
}

async function wire(
  cwd: string,
  wiring: {
    readonly add: BlueprintWiring;
    readonly remove: BlueprintWiring;
    readonly keep: BlueprintWiring;
  },
  migrations: readonly BlueprintMigrationWrite[],
  installedEdits: readonly GeneratedEdit[],
): Promise<Wiring> {
  const { add, remove, keep } = wiring;
  const added: GeneratedEdit[] = [];
  const reverted: GeneratedEdit[] = [];
  const inPlace: InPlaceEdit[] = [];
  const config = (await readTextIfPresent(cwd, APP_CONFIG_FILE)) ?? '';
  const configured = configLinesAdded(
    configLinesRemoved(config, remove, installedEdits, reverted),
    add,
    added,
  );
  if (configured !== config) inPlace.push({ path: APP_CONFIG_FILE, text: configured });
  if (migrations.length > 0) {
    const text = journalWithMigrations(await journalOf(cwd), migrations, added);
    inPlace.push({ path: JOURNAL_FILE, text });
  }
  return { inPlace, added, reverted, kept: configEditsOf(keep, installedEdits) };
}

function sourceLine(release: { readonly package: string; readonly version: string }): string {
  return `${release.package}@${release.version}`;
}

/** Each slot: `bound` when `agent-workspace.yaml` defines it, else the lines that bind it (D3). */
function slotLines(slots: readonly BlueprintSlotStatus[]): string {
  if (slots.length === 0) return '';
  const lines = slots.map((slot) => {
    if (slot.bound) return `  bound     ${slot.kind} ${slot.slot}\n`;
    return slot.kind === 'connector'
      ? `  to bind   connector ${slot.slot}: add to agent-workspace.yaml\n              connectors:\n                ${slot.slot}:\n                  url: https://<host>/mcp\n`
      : `  to bind   secret ${slot.slot}: reference it as { secret: ${slot.slot} } in agent-workspace.yaml and set its value with aw secrets create; a blueprint never carries the value\n`;
  });
  return `slots:\n${lines.join('')}`;
}

function editLines(wiring: Wiring): string {
  return [
    ...wiring.added.map((edit) => `  edit      ${edit.path}: ${edit.added.trim()}\n`),
    ...wiring.reverted.map((edit) => `  revert    ${edit.path}: ${edit.added.trim()}\n`),
    ...wiring.kept.map((edit) => `  keep      ${edit.path}: ${edit.added.trim()} (now yours)\n`),
  ].join('');
}

function changeLine(change: BlueprintFileChange): string {
  if (change.action === 'conflict') {
    const proposal =
      change.write === undefined
        ? 'removed by the new version; kept as your own'
        : `edited here; the new version is proposed as ${change.write}`;
    return `  conflict  ${change.path} (${proposal})\n`;
  }
  return `  ${change.action.padEnd(9)} ${change.path}\n`;
}

/** The one `<name>` positional, refused when missing, blank or followed by another word. */
function onlyArgument(context: LocalCommandContext, what: string, name: string): string {
  const [value, ...extra] = context.positionals;
  if (value === undefined || value.trim() === '') throw new UsageError(`${what} needs ${name}`);
  if (extra.length > 0) throw new UsageError(`${what} takes one ${name}; got ${extra.join(' ')}`);
  return value;
}

function pending(command: string, io: CliIo): never {
  io.stderr(`nothing written; run ${command} --yes to apply it\n`);
  throw new ChangesPendingError('changes are pending; re-run with --yes to apply them');
}

async function runAdd(context: LocalCommandContext, fetch: BlueprintFetch): Promise<void> {
  const cwd = cwdOf(context, 'aw blueprint add');
  const spec = onlyArgument(context, 'aw blueprint add', '<npm-spec>');
  const manifest = await readManifest(cwd);
  const appName = await generatedApp(cwd, manifest);
  const release = await fetchRelease(context, fetch, cwd, spec, appName);
  const state = await appState(
    cwd,
    manifest,
    release.manifest.parts.map((part) => part.path),
    [],
  );
  const plan = refusedBlueprint(() => planBlueprintInstall(release, state));
  const none = { resources: [], recipes: [] };
  const wiring = await wire(
    cwd,
    { add: plan.wiring, remove: none, keep: none },
    plan.migrations,
    [],
  );
  const files = plan.writes.map((write) => ({ path: write.path, contents: write.contents }));
  const taken = await conflicts(cwd, files);
  if (taken.length > 0) {
    throw new CommandRefusedError(
      `aw blueprint add would overwrite existing files:\n${taken.map((file) => `  ${file}`).join('\n')}`,
      'move these files away; a blueprint never renames its parts',
    );
  }
  const command = `aw blueprint add ${spec}`;
  const yes = isOn(context, 'yes');
  context.io.stdout(
    `${command} ${yes ? 'installs' : 'would install'} ${plan.key} from ${sourceLine(release.source)} (${release.source.integrity}):\n${files
      .map((file) => `  add       ${file.path}\n`)
      .join('')}${editLines(wiring)}${slotLines(plan.slots)}`,
  );
  if (!yes) pending(command, context.io);
  const next = refusedBlueprint(() =>
    addGeneratedEntry(manifest, plan.key, { ...plan.entry, edits: wiring.added }),
  );
  await writeNewFiles(cwd, files, context.io, 'aw blueprint add');
  await writeInPlace(cwd, wiring.inPlace, context.io);
  await writeManifest(cwd, next);
  context.io.stdout(`recorded ${plan.key} in ${GENERATED_MANIFEST_FILE}\n`);
}

async function writeInPlace(cwd: string, edits: readonly InPlaceEdit[], io: CliIo): Promise<void> {
  for (const edit of edits) {
    await writeFile(path.join(cwd, edit.path), edit.text);
    io.stdout(`edited ${edit.path}\n`);
  }
}

/** The installed `blueprint:<name>` entry, refused by name when there is none. */
function installedEntry(manifest: GeneratedManifest, name: string): GeneratedEntry {
  const key = generatedEntryKey('blueprint', name);
  const entry = Object.hasOwn(manifest.entries, key) ? manifest.entries[key] : undefined;
  if (entry?.source === undefined) {
    throw new CommandRefusedError(
      `${GENERATED_MANIFEST_FILE} records no blueprint named ${name}`,
      'aw blueprint list',
    );
  }
  return entry;
}

/** An update's proposal: the plan, its wiring, and the manifest `--yes` would write. */
interface Proposal {
  readonly name: string;
  readonly plan: BlueprintUpdatePlan;
  readonly wiring: Wiring;
  readonly next: GeneratedManifest;
  readonly changed: boolean;
}

/** The sha256 of each recorded file on disk; a missing one has no key, a non-file is edited. */
async function localHashes(cwd: string, entry: GeneratedEntry): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const [file, sha256] of Object.entries(entry.files)) {
    const state = await recordedFileState(cwd, file, sha256);
    if (state === 'unchanged') hashes[file] = sha256;
    else if (state === 'edited') {
      // A directory or a link where the file was is edited too, and matches no version.
      const bytes = await readFile(path.join(cwd, file)).catch(() => undefined);
      hashes[file] = bytes === undefined ? 'not-a-file' : sha256Of(bytes);
    }
  }
  return hashes;
}

async function propose(
  context: LocalCommandContext,
  fetch: BlueprintFetch,
  what: string,
): Promise<Proposal & { readonly cwd: string }> {
  const cwd = cwdOf(context, what);
  const name = onlyArgument(context, what, '<name>');
  const to = context.args.values.get('to');
  if (to !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(to)) {
    throw new UsageError(`--to must be an exact version, such as 1.2.0; got ${to}`);
  }
  const manifest = await readManifest(cwd);
  const appName = await generatedApp(cwd, manifest);
  const installed = installedEntry(manifest, name);
  const from = installed.source?.package ?? '';
  const release = await fetchRelease(
    context,
    fetch,
    cwd,
    `${from}@${to ?? 'latest'}`,
    appName,
    from,
  );
  const recorded = Object.keys(installed.files);
  const state = await appState(
    cwd,
    manifest,
    release.manifest.parts.map((part) => part.path),
    recorded,
  );
  const hashes = await localHashes(cwd, installed);
  const plan = refusedBlueprint(() =>
    planBlueprintUpdate(installed, release, { ...state, hashes }),
  );
  const wiring = await wire(cwd, plan.wiring, plan.migrations, installed.edits);
  const edits = [
    ...installed.edits.filter(
      (edit) => !wiring.reverted.includes(edit) && !wiring.kept.includes(edit),
    ),
    ...wiring.added,
  ];
  const next = refusedBlueprint(() =>
    addGeneratedEntry(removeGeneratedEntry(manifest, plan.key), plan.key, {
      ...plan.entry,
      edits,
    }),
  );
  const changed =
    serializeGeneratedManifest(next) !== serializeGeneratedManifest(manifest) ||
    plan.changes.some((change) => change.action !== 'unchanged');
  return { cwd, name, plan, wiring, next, changed };
}

function proposalHeader(command: string, proposal: Proposal, yes: boolean): string {
  const { plan } = proposal;
  const verb = yes ? 'applies' : 'proposes';
  return `${command} ${verb} ${sourceLine(plan.from)} -> ${sourceLine(plan.to)} (${plan.to.integrity}):\n`;
}

async function runUpdate(context: LocalCommandContext, fetch: BlueprintFetch): Promise<void> {
  const proposal = await propose(context, fetch, 'aw blueprint update');
  const { cwd, name, plan, wiring } = proposal;
  const command = `aw blueprint update ${name}`;
  const yes = isOn(context, 'yes');
  if (!proposal.changed) {
    context.io.stdout(`${plan.key} is up to date at ${sourceLine(plan.to)}\n`);
    return;
  }
  const changes = plan.changes.filter((change) => change.action !== 'unchanged');
  context.io.stdout(
    `${proposalHeader(command, proposal, yes)}${changes.map(changeLine).join('')}${editLines(wiring)}${slotLines(plan.slots)}`,
  );
  if (!yes) pending(command, context.io);
  await applyChanges(cwd, changes, context.io);
  await writeInPlace(cwd, wiring.inPlace, context.io);
  await writeManifest(cwd, proposal.next);
  context.io.stdout(`recorded ${plan.key} at ${plan.to.version} in ${GENERATED_MANIFEST_FILE}\n`);
}

/**
 * Applies an update's changes: new files and sidecars are written only where nothing is (`wx`),
 * unedited files are rewritten or removed, and a conflicted file is never touched.
 */
async function applyChanges(
  cwd: string,
  changes: readonly BlueprintFileChange[],
  io: CliIo,
): Promise<void> {
  const fresh = changes.flatMap((change) =>
    change.write !== undefined && change.action !== 'update'
      ? [{ path: change.write, contents: change.contents ?? '' }]
      : [],
  );
  const taken = await conflicts(cwd, fresh);
  if (taken.length > 0) {
    throw new CommandRefusedError(
      `aw blueprint update would overwrite existing files:\n${taken.map((file) => `  ${file}`).join('\n')}`,
      'move these files away, then update again',
    );
  }
  await writeNewFiles(cwd, fresh, io, 'aw blueprint update');
  for (const change of changes) {
    if (change.action === 'update' && change.write !== undefined) {
      await writeFile(path.join(cwd, change.write), change.contents ?? '');
      io.stdout(`updated ${change.write}\n`);
    } else if (change.action === 'remove') {
      await rm(path.join(cwd, change.path));
      await removeEmptyParents(cwd, change.path);
      io.stdout(`removed ${change.path}\n`);
    }
  }
}

async function runDiff(context: LocalCommandContext, fetch: BlueprintFetch): Promise<void> {
  const proposal = await propose(context, fetch, 'aw blueprint diff');
  const { cwd, name, plan } = proposal;
  if (!proposal.changed) {
    context.io.stdout(`${plan.key} is up to date at ${sourceLine(plan.to)}\n`);
    return;
  }
  let text = proposalHeader(`aw blueprint diff ${name}`, proposal, false);
  for (const change of plan.changes) {
    if (change.action === 'unchanged') continue;
    const before = (await readTextIfPresent(cwd, change.path)) ?? '';
    const after = change.action === 'remove' ? '' : (change.contents ?? before);
    const label =
      change.action === 'conflict'
        ? `${change.path} (conflict: your edit, then ${plan.to.version})`
        : `${change.path} (${change.action})`;
    text += `${lineDiff(label, before, after)}\n`;
  }
  context.io.stdout(`${text}${editLines(proposal.wiring)}${slotLines(plan.slots)}`);
  throw new ChangesPendingError(
    `${plan.key} is behind ${sourceLine(plan.to)}; aw blueprint update ${name} proposes it`,
  );
}

async function runList(context: LocalCommandContext): Promise<void> {
  const cwd = cwdOf(context, 'aw blueprint list');
  if (context.positionals.length > 0) {
    throw new UsageError(
      `aw blueprint list takes no argument; got ${context.positionals.join(' ')}`,
    );
  }
  const manifest = await readManifest(cwd);
  const rows = Object.entries(manifest.entries).flatMap(([key, entry]) =>
    key.startsWith(BLUEPRINT_PREFIX) && entry.source !== undefined
      ? [
          {
            name: key.slice(BLUEPRINT_PREFIX.length),
            package: entry.source.package,
            version: entry.source.version,
            integrity: entry.source.integrity,
          },
        ]
      : [],
  );
  writeResult(context.io, context.mode, rows, ['name', 'package', 'version', 'integrity']);
}

/**
 * The four `blueprint` commands over a fetch port: {@link fetchBlueprint} (`npm pack`) in `aw`,
 * an in-memory tarball in the command tests.
 */
export function blueprintCommandsWith(fetch: BlueprintFetch): readonly LocalCommand[] {
  return [
    command(
      'blueprint add',
      '<npm-spec> [--yes]',
      'Install an app blueprint from npm: fetched with npm pack --ignore-scripts and checked against its integrity; shows every file, edit and slot, and writes them only with --yes (exit 3 without)',
      { controlPlane: 'none', run: (context) => runAdd(context, fetch) },
    ),
    command(
      'blueprint list',
      '[--json]',
      'The installed app blueprints: each name, npm package, exact version and integrity',
      { controlPlane: 'none', run: runList },
    ),
    command(
      'blueprint diff',
      '<name> [--to <version>]',
      "Show a blueprint's next version (npm's latest, or --to) as line diffs of each file; writes nothing, exits 3 when it has changes and 0 when it has none",
      { controlPlane: 'none', run: (context) => runDiff(context, fetch) },
    ),
    command(
      'blueprint update',
      '<name> [--to <version>] [--yes]',
      "Propose a blueprint's next version per file (add, update, remove, conflict; exit 3 without --yes); --yes applies it and writes each edited file's new version beside it as <file>.blueprint-<version>, never over it",
      { controlPlane: 'none', run: (context) => runUpdate(context, fetch) },
    ),
  ];
}

/** ADR-0166: install app blueprints from npm, and receive each new version as a proposal. */
export const blueprintCommands: readonly LocalCommand[] = blueprintCommandsWith((spec, options) =>
  fetchBlueprint(spec, options),
);
