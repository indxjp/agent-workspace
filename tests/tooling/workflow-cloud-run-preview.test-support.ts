// Shared helpers for the tests of the live Cloud Run preview workflow
// (.github/workflows/gcp-cloudrun-preview.yml): reading its jobs, steps and scripts, and running a
// step's script against stand-in tools.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const PREVIEW = readFileSync(
  path.join(ROOT, '.github/workflows/gcp-cloudrun-preview.yml'),
  'utf8',
);

/** The condition of a preview evidence step that must run whatever the browser journey did. */
export const AFTER_DEPLOY =
  "if: ${{ !cancelled() && inputs.action != 'destroy' && steps.deploy.outcome == 'success' }}";

/** Every step of the workflow named `name`, in order, as its text. */
export function steps(name: string): string[] {
  const found: string[] = [];
  let start = PREVIEW.indexOf(`      - name: ${name}\n`);
  while (start >= 0) {
    const end = PREVIEW.indexOf('\n      - name: ', start + 1);
    found.push(PREVIEW.slice(start, end < 0 ? undefined : end));
    start = PREVIEW.indexOf(`      - name: ${name}\n`, start + 1);
  }
  if (found.length === 0) throw new Error(`no step "${name}" in the preview workflow`);
  return found;
}

export function step(name: string): string {
  const [only, ...rest] = steps(name);
  if (only === undefined || rest.length > 0) throw new Error(`not one step "${name}"`);
  return only;
}

/** The text of job `job`. */
export function jobText(job: string): string {
  const start = PREVIEW.indexOf(`\n  ${job}:\n`);
  if (start < 0) throw new Error(`no job ${job}`);
  const next = /\n {2}[a-z0-9-]+:\n/gu;
  next.lastIndex = start + 1;
  return PREVIEW.slice(start, next.exec(PREVIEW)?.index ?? PREVIEW.length);
}

/** The `run: |` script of a step's text, unindented. */
export function script(stepText: string): string {
  const marker = '        run: |\n';
  const at = stepText.indexOf(marker);
  if (at < 0) throw new Error('the step has no run script');
  return stepText
    .slice(at + marker.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/u, ''))
    .join('\n');
}

/** Every step of the workflow, as its text. */
export function allSteps(): string[] {
  return PREVIEW.split('\n      - name: ')
    .slice(1)
    .map((text) => `      - name: ${text}`);
}

/** The inputs of `runWithTools`. */
export interface ToolRun {
  /** The bash script to run. */
  readonly body: string;
  /** Executable stand-ins, by command name, placed first on PATH. */
  readonly tools: Readonly<Record<string, string>>;
  /** Environment variables added to the defaults. */
  readonly env: Readonly<Record<string, string>>;
  /** Prepares the fresh directory before the script runs. */
  readonly prepare: (temp: string) => void;
}

/** The one step of the preview job named `name`: the sandbox-internet job repeats some names. */
export function previewJobStep(name: string): string {
  const preview = jobText('preview');
  const found = steps(name).filter((text) => preview.includes(text));
  if (found.length !== 1 || found[0] === undefined)
    throw new Error(`not one preview step "${name}"`);
  return found[0];
}

/** Runs `body` under the steps' default `bash -e` in a fresh directory with `tools` first on PATH. */
export function runWithTools({ body, tools, env, prepare }: ToolRun): {
  status: number | null;
  stdout: string;
  evidence: string;
} {
  const temp = mkdtempSync(path.join(tmpdir(), 'preview-step-'));
  try {
    const bin = path.join(temp, 'bin');
    execFileSync('mkdir', ['-p', bin, path.join(temp, 'evidence')]);
    for (const [name, text] of Object.entries(tools)) {
      writeFileSync(path.join(bin, name), text, { mode: 0o755 });
    }
    prepare(temp);
    const run = spawnSync('bash', ['-e', '-c', body], {
      cwd: temp,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        EVIDENCE_DIR: 'evidence',
        GITHUB_WORKSPACE: temp,
        RUNNER_TEMP: temp,
        PREFIX: 'aw-byoc-1',
        GCP_PROJECT: 'example-project',
        GCP_REGION: 'asia-northeast1',
        ...env,
      },
    });
    const files = readdirSync(path.join(temp, 'evidence'));
    const evidence = files
      .map((file) => readFileSync(path.join(temp, 'evidence', file), 'utf8'))
      .join('');
    return { status: run.status, stdout: `${run.stdout}${run.stderr}`, evidence };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
