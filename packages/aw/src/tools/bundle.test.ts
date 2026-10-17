import { createHash } from 'node:crypto';
import { rm, symlink } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { tempDirectory, tempFile } from '../testing.js';
import { bundleCodeTool, type BundleResult } from './bundle.js';

/**
 * Issue #790 (ADR-0118 TS1): a code tool's run file becomes one content-addressed ES module, and a
 * file the sandbox could not run is refused here, by tool and package name, before any upload.
 */
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const TOOL = { file: 'tools/get-order.ts', name: 'get_order', run: './tools/get-order.run.ts' };

async function project(files: Record<string, string>): Promise<string> {
  const root = await tempDirectory();
  roots.push(root);
  for (const [name, content] of Object.entries(files)) await tempFile(root, name, content);
  return root;
}

const RUN = `import { readFile } from 'node:fs/promises';
import { shout } from './shout.ts';
export default async ({ id }: { id: string }) => shout(await readFile(id, 'utf8'));
`;
const SHOUT = `export const shout = (text: string): string => text.toUpperCase();\n`;
const FILES = { 'tools/get-order.run.ts': RUN, 'tools/shout.ts': SHOUT };

function bundled(result: BundleResult) {
  if (!result.ok) throw new Error(`expected a bundle, got ${result.problem.code}`);
  return result.bundle;
}

function refused(result: BundleResult) {
  if (result.ok) throw new Error('expected a refusal');
  return result.problem;
}

describe('bundleCodeTool', () => {
  it('bundles the run file and what it imports into one module addressed by its SHA-256', async () => {
    const root = await project(FILES);
    const bundle = bundled(await bundleCodeTool(root, TOOL));
    const text = Buffer.from(bundle.bytes).toString('utf8');
    expect(bundle.tool).toBe('get_order');
    expect(bundle.digest).toBe(createHash('sha256').update(bundle.bytes).digest('hex'));
    expect(text).toContain('toUpperCase');
    expect(text).not.toContain('./shout');
    expect(text).toMatch(/export\s*\{[^}]*as default/u);
  });

  it('keeps Node built-ins external', async () => {
    const bundle = bundled(await bundleCodeTool(await project(FILES), TOOL));
    expect(Buffer.from(bundle.bytes).toString('utf8')).toMatch(/from\s*"node:fs\/promises"/u);
  });

  it('gives the same digest for the same source, wherever the project is', async () => {
    const first = bundled(await bundleCodeTool(await project(FILES), TOOL));
    const second = bundled(await bundleCodeTool(await project(FILES), TOOL));
    expect(second.digest).toBe(first.digest);
    expect(Buffer.from(second.bytes)).toEqual(Buffer.from(first.bytes));
  });

  it('changes the digest when an imported module changes, and not when an unrelated file does', async () => {
    const root = await project({ ...FILES, 'notes.md': 'one' });
    const before = bundled(await bundleCodeTool(root, TOOL)).digest;

    await tempFile(root, 'notes.md', 'two');
    await tempFile(root, 'tools/unrelated.ts', 'export const x = 1;\n');
    expect(bundled(await bundleCodeTool(root, TOOL)).digest).toBe(before);

    await tempFile(root, 'tools/shout.ts', SHOUT.replace('toUpperCase', 'toLowerCase'));
    expect(bundled(await bundleCodeTool(root, TOOL)).digest).not.toBe(before);
  });

  it('bundles in a dependency of the project, including one that requires a built-in', async () => {
    const root = await project({
      'tools/get-order.run.ts': `import shout from 'loud';\nexport default () => shout('a');\n`,
      'node_modules/loud/package.json': '{"name":"loud","version":"1.0.0","main":"index.js"}',
      'node_modules/loud/index.js': `const os = require('os');\nmodule.exports = (text) => text.toUpperCase() + os.EOL;\n`,
    });
    const text = Buffer.from(bundled(await bundleCodeTool(root, TOOL)).bytes).toString('utf8');
    expect(text).toContain('toUpperCase');
    expect(text).not.toMatch(/from\s*"loud"/u);
    expect(text).toContain('createRequire');
  });

  it('refuses a dependency that needs a native addon, by tool and package name, and carries no bundle', async () => {
    const root = await project({
      'tools/get-order.run.ts': `import native from '@acme/addon';\nexport default () => native();\n`,
      'node_modules/@acme/addon/package.json':
        '{"name":"@acme/addon","version":"1.0.0","main":"index.js"}',
      'node_modules/@acme/addon/index.js': 'module.exports = () => 1;\n',
      'node_modules/@acme/addon/binding.gyp': '{}',
    });
    const problem = refused(await bundleCodeTool(root, TOOL));
    expect(problem).toMatchObject({
      file: 'tools/get-order.ts',
      status: null,
      code: 'tool_bundle_native_addon',
      details: ['get_order: @acme/addon'],
    });
  });

  it('refuses a dependency that loads a .node file', async () => {
    const root = await project({
      'tools/get-order.run.ts': `import native from 'fast';\nexport default () => native();\n`,
      'node_modules/fast/package.json': '{"name":"fast","version":"1.0.0","main":"index.js"}',
      'node_modules/fast/index.js': `module.exports = require('./build/fast.node');\n`,
    });
    expect(refused(await bundleCodeTool(root, TOOL))).toMatchObject({
      code: 'tool_bundle_native_addon',
      details: ['get_order: fast'],
    });
  });

  it('refuses a bundle that names the database layer', async () => {
    const root = await project({
      'tools/get-order.run.ts': `import { db } from '@agent-workspace/core/db';\nexport default () => db;\n`,
    });
    expect(refused(await bundleCodeTool(root, TOOL))).toMatchObject({
      code: 'tool_bundle_database_layer',
      details: ['get_order', '@agent-workspace/core/db'],
    });
  });

  it('reports a source that does not compile against its file and line', async () => {
    const root = await project({ 'tools/get-order.run.ts': 'export default (;\n' });
    const problem = refused(await bundleCodeTool(root, TOOL));
    expect(problem.code).toBe('tool_bundle_failed');
    expect(problem.details[0]).toBe('get_order');
    expect(problem.details[1]).toMatch(/^tools\/get-order\.run\.ts:1:\d+: /u);
  });

  it('reports an import that resolves to nothing', async () => {
    const root = await project({
      'tools/get-order.run.ts': `import x from 'not-installed';\nexport default () => x;\n`,
    });
    const problem = refused(await bundleCodeTool(root, TOOL));
    expect(problem.code).toBe('tool_bundle_failed');
    expect(problem.details.join('\n')).toContain('not-installed');
  });

  it('refuses a run file that is not there', async () => {
    expect(refused(await bundleCodeTool(await project({}), TOOL))).toMatchObject({
      file: 'tools/get-order.ts',
      code: 'tool_run_file_missing',
      details: ['get_order: ./tools/get-order.run.ts'],
    });
  });

  it('refuses a run file outside the project, and carries no bundle', async () => {
    const outside = await project({ 'outside.ts': SHOUT, 'project/package.json': '{}' });
    const root = path.join(outside, 'project');
    const tool = { ...TOOL, run: '../outside.ts' };
    expect(refused(await bundleCodeTool(root, tool))).toMatchObject({
      code: 'tool_run_file_outside_project',
      details: ['get_order: ../outside.ts'],
    });
  });

  it('refuses an in-project symlink that points outside the project, and carries no bundle', async () => {
    const outside = await project({ 'outside.ts': SHOUT, 'project/package.json': '{}' });
    const root = path.join(outside, 'project');
    await symlink(path.join(outside, 'outside.ts'), path.join(root, 'link.ts'));
    const tool = { ...TOOL, run: './link.ts' };
    expect(refused(await bundleCodeTool(root, tool))).toMatchObject({
      code: 'tool_run_file_outside_project',
      details: ['get_order: ./link.ts'],
    });
  });
});
