import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function standaloneHarness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'journey-standalone-'));
  directories.push(directory);
  const source = readFileSync(path.join(import.meta.dirname, 'run-machine.mjs'), 'utf8');
  const manifest = /const RUNNER_FILES = \[([\s\S]*?)\];/u.exec(source)?.[1];
  if (manifest === undefined) throw new Error('the clean machine declares no runner files');
  const modules = [
    'harness.mjs',
    ...[...manifest.matchAll(/'([^']+\.mjs)'/gu)].map((match) => match[1]),
  ];
  for (const module of modules) {
    if (module === undefined) throw new Error('a runner module has no filename');
    copyFileSync(path.join(import.meta.dirname, module), path.join(directory, module));
  }
  return { directory, harness: path.join(directory, 'harness.mjs') };
}

describe('the harness copied into a clean machine', () => {
  it('runs snapshot with no repository packages installed', () => {
    const { directory, harness } = standaloneHarness();
    const project = path.join(directory, 'project');
    mkdirSync(project);
    writeFileSync(path.join(project, 'agent.ts'), 'agent source');
    mkdirSync(path.join(project, '.aw'));
    writeFileSync(path.join(project, '.aw', 'runtime.log'), 'tool-owned');
    const output = execFileSync(process.execPath, [harness, 'snapshot', project], {
      encoding: 'utf8',
    });
    const snapshot: unknown = JSON.parse(output);
    expect(snapshot).toEqual({
      'agent.ts': 'c549b21352c7de3ca9ef374f63b058da30aa6716a2fae7951aff89f171079fa6',
    });
  });

  it('finds secrets outside the sealed store without printing their values', () => {
    const { directory, harness } = standaloneHarness();
    const project = path.join(directory, 'project');
    const sealed = path.join(project, '.agent-workspace', 'postgres');
    mkdirSync(sealed, { recursive: true });
    const secret = 'standalone-harness-private-value';
    writeFileSync(path.join(project, 'transcript.txt'), secret);
    writeFileSync(path.join(sealed, 'credential'), secret);
    const output = execFileSync(process.execPath, [harness, 'find', project], {
      encoding: 'utf8',
      env: { ...process.env, JOURNEY_SECRET: secret },
    });
    expect(JSON.parse(output)).toEqual([`${project}/transcript.txt`]);
    expect(output).not.toContain(secret);
  });
});
