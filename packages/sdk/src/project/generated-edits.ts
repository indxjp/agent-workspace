/**
 * Undoing one edit a generator recorded in `aw-generated.json` (issues #1505, #1531): `aw destroy`
 * reverts the edits of the entry it removes, and the apps benchmark reverts every recorded edit of
 * a file to tell a generated file from one a developer changed. Each edit is one line, `added`:
 *
 * - `package.json`: one pinned package, `{"<section>":{"<name>":"<version>"}}`, removed only while
 *   still pinned at that version; or one script, `{"scripts":{"<name>":"<command>"}}`, removed only
 *   while it still runs that command. A section left empty is removed with it.
 * - `db/migrations/meta/_journal.json`: a migration's entry as one line of JSON, dropped only while
 *   it is the journal's last entry (an earlier one needs a drop migration).
 * - any other file: a verbatim line, removed while still present; or, with `replaced`, put back as
 *   the line it took the place of.
 *
 * Pure and portable: text in, text out, no Node.js module.
 */
import { z } from 'zod';

import type { GeneratedEdit } from './generated-manifest.js';

/** The project's npm manifest, which `generate app` adds its packages and scripts to. */
export const PACKAGE_MANIFEST_FILE = 'package.json';

/** The app's migration journal, which `generate resource` adds each migration to. */
export const MIGRATION_JOURNAL_FILE = 'db/migrations/meta/_journal.json';

/** What reverting one edit found: the text without it, the line already gone, or a refusal. */
export type GeneratedEditRevert =
  | { readonly kind: 'reverted'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'refused'; readonly reason: string };

function linesOf(text: string): string[] {
  return text.split('\n');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `package.json`'s dependency and script maps, read loosely: it is the developer's file. */
const PackageManifestSchema = z.looseObject({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

/** `package.json` as {@link readPackageManifest} reads it: its own keys, in its own order. */
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

/** `package.json` parsed, or `undefined` when it is not a JSON object with string dependencies. */
export function readPackageManifest(text: string): PackageManifest | undefined {
  // npm accepts a byte-order mark; `JSON.parse` does not.
  const json = safeJson(text.replace(/^\uFEFF/u, ''));
  const parsed = PackageManifestSchema.safeParse(json);
  if (!parsed.success || typeof json !== 'object' || json === null) return undefined;
  // Zod lists the schema's keys first. The file's own key order is kept, so `scripts` stays where
  // the developer put it and a revert restores the file byte for byte.
  const ordered = Object.fromEntries(Object.keys(json).map((key) => [key, undefined]));
  return Object.assign(ordered, parsed.data);
}

/** `manifest` written back with the indentation and final newline of `original`. */
export function serializePackageManifest(original: string, manifest: PackageManifest): string {
  const indent = /^[{[][^\n]*\n([ \t]+)/u.exec(original)?.[1] ?? '  ';
  return `${JSON.stringify(manifest, null, indent)}${original.endsWith('\n') ? '\n' : ''}`;
}

/** One recorded package edit: `{"<section>":{"<name>":"<version>"}}`, one package. */
const PinSchema = z.record(z.string(), z.string()).refine((pins) => Object.keys(pins).length === 1);
const PackageEditSchema = z.union([
  z.strictObject({ dependencies: PinSchema }).transform((edit) => ({
    section: 'dependencies' as const,
    pins: edit.dependencies,
  })),
  z.strictObject({ devDependencies: PinSchema }).transform((edit) => ({
    section: 'devDependencies' as const,
    pins: edit.devDependencies,
  })),
  z.strictObject({ scripts: PinSchema }).transform((edit) => ({
    section: 'scripts' as const,
    pins: edit.scripts,
  })),
]);

function withoutPackage(text: string, added: string): GeneratedEditRevert {
  const manifest = readPackageManifest(text);
  const edit = PackageEditSchema.safeParse(safeJson(added));
  if (manifest === undefined || !edit.success) {
    return { kind: 'refused', reason: 'is not a package.json aw can read; remove it by hand' };
  }
  const { section, pins } = edit.data;
  const [name = '', version] = Object.entries(pins)[0] ?? [];
  const current = manifest[section];
  if (current === undefined || current[name] !== version) return { kind: 'absent' };
  const rest = Object.fromEntries(Object.entries(current).filter(([other]) => other !== name));
  const next: PackageManifest = { ...manifest, [section]: rest };
  // A section the generator created is removed with its last package.
  if (Object.keys(rest).length === 0) delete next[section];
  return { kind: 'reverted', text: serializePackageManifest(text, next) };
}

/** One entry of Drizzle's migration journal. */
const JournalEntrySchema = z.strictObject({
  idx: z.int().min(0),
  version: z.string().min(1).max(16),
  when: z.int().min(0),
  tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/u),
  breakpoints: z.boolean(),
});

/** The journal `generate app` writes and `generate resource` appends to. */
const JournalSchema = z.strictObject({
  version: z.string().min(1).max(16),
  dialect: z.literal('postgresql'),
  entries: z.array(JournalEntrySchema).min(1),
});

/** The migration journal, as {@link readMigrationJournal} reads it. */
export type MigrationJournal = z.infer<typeof JournalSchema>;

/** One migration of a {@link MigrationJournal}. */
export type MigrationJournalEntry = z.infer<typeof JournalEntrySchema>;

/** The journal parsed, or `undefined` when it is not one whose entries count up from 0. */
export function readMigrationJournal(text: string): MigrationJournal | undefined {
  const parsed = JournalSchema.safeParse(safeJson(text));
  if (!parsed.success) return undefined;
  return parsed.data.entries.every((entry, index) => entry.idx === index) ? parsed.data : undefined;
}

/** The journal as Drizzle and the app template write it: two-space JSON and a final newline. */
export function serializeMigrationJournal(journal: MigrationJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

/** A flat JSON value written with its keys sorted, so two key orders compare equal. */
function sortedJson(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return JSON.stringify(value) ?? '';
  }
  return JSON.stringify(value, Object.keys(value).sort());
}

function withoutJournalEntry(text: string, added: string): GeneratedEditRevert {
  const journal = readMigrationJournal(text);
  if (journal === undefined) {
    return { kind: 'refused', reason: 'is not a migration journal aw can read; fix it by hand' };
  }
  const entry = sortedJson(safeJson(added));
  const index = journal.entries.findIndex((candidate) => sortedJson(candidate) === entry);
  if (index === -1) return { kind: 'absent' };
  if (index !== journal.entries.length - 1) {
    const tag = journal.entries[index]?.tag ?? '';
    return {
      kind: 'refused',
      reason: `lists ${tag} before a later migration, so dropping it would rewrite history; write a drop migration instead`,
    };
  }
  return {
    kind: 'reverted',
    text: serializeMigrationJournal({ ...journal, entries: journal.entries.slice(0, -1) }),
  };
}

/** `text` with the line `added` put back as `replaced`, while `added` is still there verbatim. */
function withLineRestored(text: string, added: string, replaced: string): GeneratedEditRevert {
  const all = linesOf(text);
  const index = all.indexOf(added);
  if (index === -1) return { kind: 'absent' };
  all[index] = replaced;
  return { kind: 'reverted', text: all.join('\n') };
}

function withoutLine(text: string, line: string): GeneratedEditRevert {
  const all = linesOf(text);
  const index = all.indexOf(line);
  if (index === -1) return { kind: 'absent' };
  all.splice(index, 1);
  return { kind: 'reverted', text: all.join('\n') };
}

/**
 * Reverts one recorded edit of the file whose text is `text`.
 *
 * @returns the text without the edit; `absent` when the edit is no longer there (left as is); or
 *   `refused`, with the reason, when the file is not one the edit can be taken out of safely.
 */
export function revertGeneratedEdit(text: string, edit: GeneratedEdit): GeneratedEditRevert {
  if (edit.path === PACKAGE_MANIFEST_FILE) return withoutPackage(text, edit.added);
  if (edit.path === MIGRATION_JOURNAL_FILE) return withoutJournalEntry(text, edit.added);
  if (edit.replaced !== undefined) return withLineRestored(text, edit.added, edit.replaced);
  return withoutLine(text, edit.added);
}
