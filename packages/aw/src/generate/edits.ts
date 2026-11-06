/**
 * The edits `aw generate` makes to files it did not write (issue #1505). Each is recorded in
 * `aw-generated.json` as one line, `added`:
 *
 * - `app.config.ts`: the resource's import and its entry in `resources: [...]`, or the recipe's
 *   in `recipes: [...]` (issue #1514), each a verbatim line.
 * - `package.json`: one pinned package, recorded as `{"<section>":{"<name>":"<version>"}}`, or one
 *   script, `{"scripts":{"<name>":"<command>"}}`.
 * - `db/migrations/meta/_journal.json`: the resource's migration entry as one line of JSON.
 * - a resource's route file (issue #1519): the channel's import, a verbatim line, and the route
 *   line `replaced` by one passing `{ publish }`.
 *
 * How `aw destroy` reverts them is the SDK's `revertGeneratedEdit` (issue #1531), so the apps
 * benchmark reverts them the same way; it is re-exported here under the names `aw` uses.
 *
 * Pure: text in, text out.
 */
import {
  MIGRATION_JOURNAL_FILE,
  PACKAGE_MANIFEST_FILE,
  serializePackageManifest,
  readPackageManifest,
  type AppScript,
  type GeneratedEdit,
  type MigrationJournal,
  type MigrationJournalEntry,
  type PackageManifest,
} from '@indx-workspace/sdk/project';

import type { PinnedPackage } from './app-kit.js';

export {
  readMigrationJournal as readJournal,
  readPackageManifest,
  revertGeneratedEdit as revertEdit,
  serializeMigrationJournal as serializeJournal,
  type PackageManifest,
} from '@indx-workspace/sdk/project';

/** The app's configuration file, which `generate resource` adds each resource to. */
export const APP_CONFIG_FILE = 'app.config.ts';
/** The project's npm manifest, which `generate app` adds its packages to. */
export const PACKAGE_FILE = PACKAGE_MANIFEST_FILE;
/** The app's migration journal, which `generate resource` adds each migration to. */
export const JOURNAL_FILE = MIGRATION_JOURNAL_FILE;

function linesOf(text: string): string[] {
  return text.split('\n');
}

/** The lists of `defineApp` a generator adds an entry to. */
export type AppConfigList = 'resources' | 'recipes';

/**
 * `app.config.ts` with a resource's (or a recipe's) two lines: the import after the last import,
 * the entry as the last item of `resources: [...]` (or `recipes: [...]`). `undefined` when the
 * file has no such list on lines of its own (a hand-written config), so the caller refuses rather
 * than guess.
 */
export function withAppConfigLines(
  text: string,
  lines: { readonly import: string; readonly entry: string },
  list: AppConfigList = 'resources',
): string | undefined {
  const all = linesOf(text);
  if (all.includes(lines.import)) return undefined;
  const opening = new RegExp(`^\\s*${list}:\\s*\\[\\s*$`, 'u');
  const open = all.findIndex((line) => opening.test(line));
  const close = all.findIndex((line, index) => index > open && /^\s*\],?\s*$/u.test(line));
  const lastImport = all.findLastIndex((line) => line.startsWith('import '));
  if (open === -1 || close === -1 || lastImport === -1 || lastImport > open) return undefined;
  all.splice(close, 0, lines.entry);
  all.splice(lastImport + 1, 0, lines.import);
  return all.join('\n');
}

/**
 * `text` with `edit.import` after its last import and the line `edit.replaced` replaced by
 * `edit.added`; `undefined` when the line is not there exactly once, the import is already
 * there, or the file has no import (a route file edited by hand), so the caller refuses.
 */
export function withReplacedLine(
  text: string,
  edit: { readonly import: string; readonly replaced: string; readonly added: string },
): string | undefined {
  const all = linesOf(text);
  const at = all.indexOf(edit.replaced);
  const lastImport = all.findLastIndex((line) => line.startsWith('import '));
  if (
    at === -1 ||
    all.lastIndexOf(edit.replaced) !== at ||
    all.includes(edit.import) ||
    lastImport === -1 ||
    lastImport > at
  ) {
    return undefined;
  }
  all[at] = edit.added;
  all.splice(lastImport + 1, 0, edit.import);
  return all.join('\n');
}

/** A spec that pins `version`, or one a protocol pins (`workspace:*`, `file:../app`). */
function pinsVersion(spec: string, version: string): boolean {
  return spec === version || spec.includes(':');
}

/** What `package.json` already says about one package `generate app` adds. */
export type PinState = 'missing' | 'pinned' | 'conflicting';

export function pinState(manifest: PackageManifest, pin: PinnedPackage): PinState {
  const spec = manifest.dependencies?.[pin.name] ?? manifest.devDependencies?.[pin.name];
  if (spec === undefined) return 'missing';
  return pinsVersion(spec, pin.version) ? 'pinned' : 'conflicting';
}

/** The recorded edit of one package added to `package.json`. */
export function packageEdit(pin: PinnedPackage): GeneratedEdit {
  return {
    path: PACKAGE_FILE,
    added: JSON.stringify({ [pin.section]: { [pin.name]: pin.version } }),
  };
}

/** The scripts of `scripts` that `package.json` has no script of that name for. */
export function missingScripts(
  manifest: PackageManifest,
  scripts: readonly AppScript[],
): readonly AppScript[] {
  return scripts.filter((script) => manifest.scripts?.[script.name] === undefined);
}

/**
 * `package.json` with `pins` added to their sections and `scripts` to its scripts, each section
 * created when missing.
 */
export function withPackages(
  text: string,
  pins: readonly PinnedPackage[],
  scripts: readonly AppScript[] = [],
): string | undefined {
  const manifest = readPackageManifest(text);
  if (manifest === undefined) return undefined;
  const next: PackageManifest = { ...manifest };
  for (const pin of pins) next[pin.section] = { ...next[pin.section], [pin.name]: pin.version };
  for (const script of scripts) {
    next.scripts = { ...next.scripts, [script.name]: script.command };
  }
  return serializePackageManifest(text, next);
}

/**
 * The journal entry of a resource's migration `<NNNN>_create_<plural>`. Its `when` is one
 * millisecond after the last entry's, so the same journal always gives the same entry and Drizzle
 * applies it after every earlier one.
 */
export function nextJournalEntry(journal: MigrationJournal, plural: string): MigrationJournalEntry {
  const last = journal.entries.at(-1);
  const idx = journal.entries.length;
  return {
    idx,
    version: last?.version ?? '7',
    when: (last?.when ?? 0) + 1,
    tag: `${String(idx).padStart(4, '0')}_create_${plural}`,
    breakpoints: true,
  };
}

/** The recorded edit of one journal entry. */
export function journalEdit(entry: MigrationJournalEntry): GeneratedEdit {
  return { path: JOURNAL_FILE, added: JSON.stringify(entry) };
}
