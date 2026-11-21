/**
 * The source hash of an entry (the Agent Store 100-use-case plan, §7): what an R1 record says it
 * verified, so a real-model verification goes stale when that changes and "verified" always means
 * "this code, with this demo, was verified". Defined once, here; the harness writes it, and the
 * scoreboard and the catalog's promotion check join on it.
 *
 * What it covers, deterministically and the same on every machine:
 * - Every file git tracks under the entry's source folder (`git ls-files`), read from the working
 *   tree, sorted by path, each as its path relative to the folder and the sha256 of its bytes. Only
 *   tracked files: an untracked or ignored file (a build output, a local scratch file) never counts,
 *   so two checkouts of one commit hash alike.
 * - The entry's demo block in the catalog (its agent, prompts, moment check, seed folders and records
 *   folder), as JSON with sorted keys, so a changed prompt or a weakened check makes the record
 *   stale. Its `status` is not part of it: a coming-soon entry carries the same source and demo it
 *   will have when live, so flipping it to live keeps its record.
 * What it leaves out, and why:
 * - Tests and test support (`*.test.*`, `*.spec.*`, `*.test-support.*`) and the folder's `e2e/`:
 *   they never reach the deployment, so a test-only change does not ask for a new real-model run.
 * - The folder's own top-level `README.md`: documentation for people, never read by the agent.
 * - Everything outside the folder: the shared packages (`packages/**`, the SDK and the platform) and
 *   the gallery harness. A change there can change the agent's behaviour without making a record
 *   stale; the daily production test, not R1, is what watches the platform.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CatalogEntry } from '../../../examples/store/catalog/define.ts';
import {
  REAL_MODEL_EVIDENCE,
  type RealModelRun,
} from '../../../examples/store/catalog/verification.ts';

/** The repository root, which every source folder is relative to. */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** A file of the folder that never reaches the deployment (path relative to the folder). */
const NOT_SHIPPED = /\.(?:test|spec|test-support)\.[^/]+$|^e2e\/|^README\.md$/u;

/**
 * The folder an entry's code is in, relative to the repository root: its `source` (a live entry's,
 * or a coming-soon entry's once its code is merged), else `use-cases/<slug>`, where an entry still
 * coming soon is written before it goes live.
 */
export function sourceFolderOf(entry: CatalogEntry): string {
  return entry.source ?? `use-cases/${entry.slug}`;
}

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** `value` as JSON with every object's keys sorted, so equal values print alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The lines of the folder's files the hash covers, or none when it holds no such file. */
function folderLines(folder: string, root: string): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', folder], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const prefix = `${folder.replace(/\/+$/u, '')}/`;
  return (
    listed
      .split('\0')
      .filter((file) => file.startsWith(prefix))
      // A tracked file deleted in the working tree is gone from the source.
      .filter((file) => existsSync(path.join(root, file)))
      .map((file) => file.slice(prefix.length))
      .filter((file) => !NOT_SHIPPED.test(file))
      .sort()
      .map((file) => `${file}\0${sha256(readFileSync(path.join(root, prefix, file)))}\n`)
  );
}

/**
 * The source hash of `folder` (relative to `root`) alone, or `null` when the folder holds no file the
 * hash covers (it does not exist yet, say).
 */
export function sourceHash(folder: string, root: string = REPOSITORY_ROOT): string | null {
  const lines = folderLines(folder, root);
  return lines.length === 0 ? null : sha256(lines.join(''));
}

/**
 * The source hash of `entry`: its folder ({@link sourceFolderOf}, or `folder` when given) and its
 * demo block. `null` when the folder holds no file the hash covers.
 */
export function entrySourceHash(
  entry: CatalogEntry,
  root: string = REPOSITORY_ROOT,
  folder: string = sourceFolderOf(entry),
): string | null {
  const lines = folderLines(folder, root);
  if (lines.length === 0) return null;
  const demo = entry.demo === undefined ? 'null' : canonicalJson(entry.demo);
  return sha256(`${lines.join('')}\0demo\0${demo}\n`);
}

/**
 * Why `entry` as checked out differs from what the deployment at commit `deployed` seeded: its source
 * folder or its catalog file is not the same git tree there, or has uncommitted changes here. `null`
 * when they are the same, so a real-model run verifies exactly the code it runs.
 */
export function deployedSourceDiffers(
  entry: CatalogEntry,
  deployed: string,
  root: string = REPOSITORY_ROOT,
): string | null {
  const git = (args: readonly string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  for (const item of [sourceFolderOf(entry), `examples/store/catalog/${entry.slug}.ts`]) {
    if (git(['status', '--porcelain', '--', item]) !== '') {
      return `${item} has uncommitted changes`;
    }
    const at = (rev: string): string => {
      try {
        return git(['rev-parse', '--verify', '--quiet', `${rev}:${item}`]);
      } catch {
        return '';
      }
    };
    const here = at('HEAD');
    if (here === '' || here !== at(deployed)) {
      return `${item} differs from what the deployment at ${deployed.slice(0, 12)} seeded`;
    }
  }
  return null;
}

/**
 * Whether `slug` has a passing R1 record for the source it has now: the latest of its records made
 * on `hash` passed. `null` (no source to hash) never has one. Kept here, beside the hash, rather
 * than in the store's catalog: the store never reads it, and its lines would count toward the store.
 */
export function passedForSource(
  slug: string,
  hash: string | null,
  runs: readonly RealModelRun[] = REAL_MODEL_EVIDENCE.runs,
): boolean {
  if (hash === null) return false;
  const latest = runs
    .filter((run) => run.entry === slug && run.sourceHash === hash)
    .reduce<RealModelRun | null>(
      (last, run) => (last === null || Date.parse(run.date) > Date.parse(last.date) ? run : last),
      null,
    );
  return latest?.result === 'pass';
}
