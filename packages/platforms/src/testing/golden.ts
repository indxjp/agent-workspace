import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  PortableProjectSchema,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import type { FieldVerdict, PlatformFile } from '@indx-workspace/contracts/platforms';

import type { PlatformCompileResult } from '../port.js';

const REPORT_FILE = 'report.json';
const EXPECTED_DIR = 'expected';
const encoder = new TextEncoder();

function updating(): boolean {
  return process.env['UPDATE_GOLDEN'] === '1';
}

function bytesOf(content: PlatformFile['content']): Uint8Array {
  return typeof content === 'string' ? encoder.encode(content) : content;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function reportJson(report: readonly FieldVerdict[]): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function compiled(result: PlatformCompileResult): {
  files: readonly PlatformFile[];
  report: readonly FieldVerdict[];
} {
  if (!result.ok) {
    throw new Error(`cannot compare a refusal to a golden: ${result.refusal.code}`);
  }
  return result;
}

/** One line per difference, each naming the path; empty when the two sets are equal. */
function differences(actual: Map<string, Uint8Array>, golden: Map<string, Uint8Array>): string[] {
  const lines: string[] = [];
  for (const [path, bytes] of actual) {
    const expected = golden.get(path);
    if (expected === undefined) lines.push(`missing from the golden: ${path}`);
    else if (!sameBytes(bytes, expected)) lines.push(`changed: ${path}`);
  }
  for (const path of golden.keys()) {
    if (!actual.has(path)) lines.push(`not emitted but in the golden: ${path}`);
  }
  return lines.sort();
}

function fail(where: string, lines: readonly string[]): never {
  throw new Error(
    `The output differs from the golden at ${where} (UPDATE_GOLDEN=1 rewrites it):\n- ${lines.join('\n- ')}`,
  );
}

function listFiles(root: string, relative = ''): string[] {
  return readdirSync(join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      return entry.isDirectory() ? listFiles(root, path) : [path];
    })
    .sort();
}

function readIfPresent(path: string): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return undefined;
  }
}

/**
 * Compares `result` with the golden directory: `<goldenDir>/expected/**` byte-exact (the same set
 * of paths) and `<goldenDir>/report.json`. With `UPDATE_GOLDEN=1` it rewrites both and deletes
 * stale files under `expected/`. For targets whose files are data (P2-P6, P8).
 */
export function expectGoldenFiles(result: PlatformCompileResult, goldenDir: string): void {
  const { files, report } = compiled(result);
  const expectedRoot = join(goldenDir, EXPECTED_DIR);
  const reportPath = join(goldenDir, REPORT_FILE);
  const actual = new Map(
    files.map((file) => [`${EXPECTED_DIR}/${file.path}`, bytesOf(file.content)]),
  );
  actual.set(REPORT_FILE, encoder.encode(reportJson(report)));

  if (updating()) {
    rmSync(expectedRoot, { recursive: true, force: true });
    for (const file of files) {
      const target = join(expectedRoot, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytesOf(file.content));
    }
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(reportPath, reportJson(report));
    return;
  }

  const golden = new Map<string, Uint8Array>();
  const present = readIfPresent(reportPath);
  if (present !== undefined) golden.set(REPORT_FILE, present);
  const expectedPaths = existsSync(expectedRoot) ? listFiles(expectedRoot) : [];
  for (const path of expectedPaths) {
    golden.set(`${EXPECTED_DIR}/${path}`, new Uint8Array(readFileSync(join(expectedRoot, path))));
  }

  const lines = differences(actual, golden);
  if (lines.length > 0) fail(goldenDir, lines);
}

const SECTION_HEADER = /^=== (.+) ===\n/gmu;

function bundleSection(content: PlatformFile['content']): string {
  const text =
    typeof content === 'string'
      ? content
      : `(hex) ${Array.from(content, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return text.endsWith('\n') ? text : `${text}\n\\ No newline at end of file\n`;
}

function renderBundle(files: readonly PlatformFile[], report: readonly FieldVerdict[]): string {
  const sections = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `=== ${file.path} ===\n${bundleSection(file.content)}`);
  sections.push(`=== ${REPORT_FILE} ===\n${reportJson(report)}`);
  return sections.join('');
}

function parseBundle(text: string): Map<string, Uint8Array> {
  const headers = [...text.matchAll(SECTION_HEADER)];
  const sections = new Map<string, Uint8Array>();
  headers.forEach((header, index) => {
    const start = header.index + header[0].length;
    const end = headers[index + 1]?.index ?? text.length;
    sections.set(header[1] ?? '', encoder.encode(text.slice(start, end)));
  });
  return sections;
}

/**
 * The one-file mode for targets that emit source code (the `eject-*` targets, P7). The golden
 * holds every emitted file in path order, each preceded by a line `=== <path> ===`, then
 * `=== report.json ===` and the report. Same compare and `UPDATE_GOLDEN=1` rules as
 * {@link expectGoldenFiles}. A `.txt` golden is inert to `tests/no-sdk-import.test.ts`, which
 * would read a committed `.ts` or `package.json` fixture for SDK declarations.
 */
export function expectGoldenBundle(result: PlatformCompileResult, goldenFile: string): void {
  const { files, report } = compiled(result);
  const rendered = renderBundle(files, report);

  if (updating()) {
    mkdirSync(dirname(goldenFile), { recursive: true });
    writeFileSync(goldenFile, rendered);
    return;
  }

  const golden = readIfPresent(goldenFile);
  if (golden === undefined) fail(goldenFile, ['the golden file does not exist']);
  const goldenText = new TextDecoder().decode(golden);
  if (goldenText === rendered) return;
  const lines = differences(parseBundle(rendered), parseBundle(goldenText));
  fail(goldenFile, lines.length > 0 ? lines : ['the section order or framing changed']);
}

/** Reads `<goldenDir>/input.json` (not `project.json`, which Nx treats as a project definition). */
export function loadGoldenProject(goldenDir: string): PortableProject {
  return PortableProjectSchema.parse(
    JSON.parse(readFileSync(join(goldenDir, 'input.json'), 'utf8')),
  );
}
