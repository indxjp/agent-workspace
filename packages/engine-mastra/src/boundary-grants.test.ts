import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { grantedFilesystemForTests } from './boundary.js';
import { drain, request, scriptedGateway, text, tool, workspace } from './boundary.test-support.js';
import { compileMastraRun } from './compile.js';
import { createMastraEngine } from './engine.js';

it('refuses a write into a read-only grant as a failed tool call, and leaves the file alone', async () => {
  const cwd = workspace();
  scriptedGateway.script = [
    tool('t1', 'mastra_workspace_write_file', {
      path: 'contracts/signed.pdf',
      content: 'forged',
    }),
    text('could not'),
  ];
  const frames = await drain(
    createMastraEngine().start(
      request(cwd, {
        resources: {
          files: [{ kind: 'file', path: 'contracts/signed.pdf', access: 'read' }],
          skills: [{ name: 'greeter', files: [] }],
        },
      }),
    ).frames,
  );
  const result = frames.find((frame) => frame.frame === 'agent.tool.result');
  expect(result).toMatchObject({ isError: true, status: 'failed' });
  expect(readFileSync(path.join(cwd, 'contracts/signed.pdf'), 'utf8')).toBe('signed');
});

it('refuses a recursive delete of a directory that holds a read-only grant, however spelled', async () => {
  const cwd = workspace();
  mkdirSync(path.join(cwd, 'docs/contracts'), { recursive: true });
  writeFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'signed');
  writeFileSync(path.join(cwd, 'docs/readme.md'), 'readme');
  scriptedGateway.script = [
    tool('t1', 'mastra_workspace_delete', { path: 'docs', recursive: true }),
    tool('t2', 'mastra_workspace_delete', { path: 'x/../docs/', recursive: true }),
    tool('t3', 'mastra_workspace_delete', { path: 'docs/readme.md' }),
    text('done'),
  ];
  const frames = await drain(
    createMastraEngine().start(
      request(cwd, {
        resources: {
          files: [{ kind: 'directory', path: 'docs/contracts', access: 'read' }],
          skills: [{ name: 'greeter', files: [] }],
        },
      }),
    ).frames,
  );
  const results = frames.filter((frame) => frame.frame === 'agent.tool.result');
  expect(results.map((frame) => [frame.isError, frame.status])).toEqual([
    [true, 'failed'],
    [true, 'failed'],
    [false, 'completed'],
  ]);
  expect(readFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'utf8')).toBe('signed');
  expect(existsSync(path.join(cwd, 'docs/readme.md'))).toBe(false);
});

it('refuses a recursive copy that would write under a read-only grant at the destination, and leaves the file alone', async () => {
  const cwd = workspace();
  mkdirSync(path.join(cwd, 'incoming/contracts'), { recursive: true });
  writeFileSync(path.join(cwd, 'incoming/contracts/signed.pdf'), 'forged');
  mkdirSync(path.join(cwd, 'docs/contracts'), { recursive: true });
  writeFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'signed');
  const compiled = compileMastraRun(
    request(cwd, {
      resources: {
        files: [{ kind: 'directory', path: 'docs/contracts', access: 'read' }],
        skills: [{ name: 'greeter', files: [] }],
      },
    }),
  );
  if (!compiled.ok) throw new Error(`expected the compile to succeed: ${compiled.reason}`);
  // `copyFile('incoming', 'docs', { recursive: true })` recurses through Mastra's own
  // `copyDirectory`, which writes each file with raw `fs.copyFile` and never calls back into this
  // wrapper's `copyFile` override, so only the guard on the top-level destination stands between
  // it and `docs/contracts/signed.pdf`.
  const filesystem = await grantedFilesystemForTests(compiled.compiled);
  await expect(filesystem.copyFile('incoming', 'docs', { recursive: true })).rejects.toThrow(
    /write refused/u,
  );
  expect(readFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'utf8')).toBe('signed');
});

it('refuses a recursive move that would write under a read-only grant at the destination, and leaves the file alone', async () => {
  const cwd = workspace();
  mkdirSync(path.join(cwd, 'incoming/contracts'), { recursive: true });
  writeFileSync(path.join(cwd, 'incoming/contracts/signed.pdf'), 'forged');
  mkdirSync(path.join(cwd, 'docs/contracts'), { recursive: true });
  writeFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'signed');
  const compiled = compileMastraRun(
    request(cwd, {
      resources: {
        files: [{ kind: 'directory', path: 'docs/contracts', access: 'read' }],
        skills: [{ name: 'greeter', files: [] }],
      },
    }),
  );
  if (!compiled.ok) throw new Error(`expected the compile to succeed: ${compiled.reason}`);
  const filesystem = await grantedFilesystemForTests(compiled.compiled);
  await expect(filesystem.moveFile('incoming', 'docs')).rejects.toThrow(/write refused/u);
  expect(readFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'utf8')).toBe('signed');
  expect(readFileSync(path.join(cwd, 'incoming/contracts/signed.pdf'), 'utf8')).toBe('forged');
});
