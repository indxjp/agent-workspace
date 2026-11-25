/**
 * The handwritten-line counter both benchmarks use: the apps benchmark (`./benchmark.ts`, every app
 * under `examples/`) and the use cases' (`use-cases/benchmark.test.ts`, every `use-cases/<slug>/`).
 *
 * A file counts unless the caller's `skip` leaves it out, it is binary (an image or a font holds no
 * lines of code), or the generators wrote it and nobody has edited it since (`aw-generated.json`,
 * whose recorded sha256 and one-line edits say so). Each benchmark decides what it skips; the
 * counting rule, the binary rule and the generated-file rule are one here.
 *
 * Pure apart from reading the directory's files.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  GENERATED_MANIFEST_FILE,
  revertGeneratedEdit,
  type GeneratedEdit,
  type GeneratedManifest,
} from '@indx-workspace/sdk/project';

/** Files whose comments start with `#`, not `//`. */
const HASH_COMMENTS = /\.(?:sh|ya?ml|py)$/u;

/**
 * The lines of `text` that count: not blank, and not only a comment (`//`, a `/* … *\/` block and
 * its `*` lines, or `#` in a shell, YAML or Python file).
 */
export function countedLines(file: string, text: string): number {
  const hash = HASH_COMMENTS.test(file);
  let inBlock = false;
  let counted = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) {
        inBlock = false;
        if (line.slice(line.indexOf('*/') + 2).trim() !== '') counted += 1;
      }
      continue;
    }
    if (line === '' || (hash && line.startsWith('#')) || (!hash && line.startsWith('//'))) continue;
    if (!hash && line.startsWith('/*')) {
      inBlock = !line.includes('*/');
      if (!inBlock && line.slice(line.indexOf('*/') + 2).trim() !== '') counted += 1;
      continue;
    }
    counted += 1;
  }
  return counted;
}

/** Every file under `dir`, relative, with `/` separators, sorted; `node_modules` and `.next` aside. */
export async function filesOf(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .filter((file) => !/(?:^|\/)(?:node_modules|\.next)\//u.test(file))
    .sort();
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Each recorded file, its sha256 and the recorded edits that target it, newest kind first. */
interface RecordedFile {
  readonly sha256: string;
  readonly edits: readonly GeneratedEdit[];
}

/**
 * The entries in the order they were generated, as far as the manifest says: the project and the
 * app first (create writes them), then everything generated over them. The manifest keeps no
 * time, so entries of one kind are in key order.
 */
function generationRank(key: string): number {
  if (key.startsWith('project:')) return 0;
  if (key.startsWith('app:')) return 1;
  return 2;
}

function recordedFiles(manifest: GeneratedManifest): Map<string, RecordedFile> {
  const entries = Object.entries(manifest.entries).sort(
    ([left], [right]) => generationRank(right) - generationRank(left),
  );
  const edits = entries.flatMap(([, entry]) => entry.edits);
  const recorded = new Map<string, RecordedFile>();
  for (const [, entry] of entries) {
    for (const [file, hash] of Object.entries(entry.files)) {
      recorded.set(file, { sha256: hash, edits: edits.filter((edit) => edit.path === file) });
    }
  }
  return recorded;
}

/**
 * Whether `text` is what the generator recorded: its sha256 matches as it is, or once the edits
 * recorded for it are reverted, newest entry first. A revert that cannot apply yet (a journal entry
 * a later one follows) is tried again after the others, until none applies.
 */
export function isUnedited(text: string, recorded: RecordedFile): boolean {
  let current = text;
  if (sha256(current) === recorded.sha256) return true;
  let pending = [...recorded.edits];
  for (let progressed = true; progressed && pending.length > 0;) {
    progressed = false;
    const next: GeneratedEdit[] = [];
    for (const edit of pending) {
      const outcome = revertGeneratedEdit(current, edit);
      if (outcome.kind !== 'reverted') {
        next.push(edit);
        continue;
      }
      current = outcome.text;
      progressed = true;
      if (sha256(current) === recorded.sha256) return true;
    }
    pending = next;
  }
  return false;
}

export type GeneratedFileState = 'unedited' | 'edited' | 'missing';

/** Each file the manifest records, and whether `dir` still holds it as generated. */
export async function generatedFileStates(
  dir: string,
  manifest: GeneratedManifest,
): Promise<Map<string, GeneratedFileState>> {
  const states = new Map<string, GeneratedFileState>();
  for (const [file, recorded] of recordedFiles(manifest)) {
    const target = path.join(dir, file);
    if (!existsSync(target)) {
      states.set(file, 'missing');
      continue;
    }
    states.set(file, isUnedited(await readFile(target, 'utf8'), recorded) ? 'unedited' : 'edited');
  }
  return new Map([...states].sort(([left], [right]) => left.localeCompare(right)));
}

/** One file counted as handwritten, and its counted lines. */
export interface HandwrittenFile {
  readonly file: string;
  readonly lines: number;
}

/** What {@link countHandwritten} found. */
export interface HandwrittenCount {
  readonly lines: number;
  readonly files: readonly HandwrittenFile[];
}

/** How far into a file {@link isBinary} looks: git's own window for the same question. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Whether `bytes` are a binary file (an image, a font, an archive), which holds no lines of code:
 * a NUL byte in its first {@link BINARY_SNIFF_BYTES}. It is the rule git uses to call a file binary,
 * so what a diff shows as "Binary files differ" is what the count skips. By content, not by
 * extension: a list of image and font extensions would count the next binary format nobody listed,
 * and would let a text file escape by its name. Every text format, SVG, XML and plain text among
 * them, holds no NUL and keeps counting.
 */
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Source files, which are never binary: a NUL in one fails the count instead of hiding it. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|css|md)$/u;

/**
 * The handwritten code under `dir`: every file the generators did not write, and every one they did
 * that has been edited since (counted in full), except the paths `skip` leaves out (relative, `/`
 * separators) and binary files ({@link isBinary}; Owner decision, 2026-11-21). `aw-generated.json`
 * is the generators' record and never counts.
 */
export async function countHandwritten(
  dir: string,
  manifest: GeneratedManifest,
  skip: (file: string) => boolean,
): Promise<HandwrittenCount> {
  const states = await generatedFileStates(dir, manifest);
  const files: HandwrittenFile[] = [];
  for (const file of await filesOf(dir)) {
    if (file === GENERATED_MANIFEST_FILE || skip(file)) continue;
    if (states.get(file) === 'unedited') continue;
    const bytes = await readFile(path.join(dir, file));
    if (isBinary(bytes)) {
      if (SOURCE_FILE.test(file))
        throw new Error(`${file} holds a NUL byte; a source file is text`);
      continue;
    }
    files.push({ file, lines: countedLines(file, bytes.toString('utf8')) });
  }
  return { lines: files.reduce((sum, file) => sum + file.lines, 0), files };
}
