/**
 * `agent-workspace render --upgrade` (BH061-026): the platform image pins move to this CLI's
 * release, which a plain `render` never does. The registry lookup (`docker buildx imagetools
 * inspect`) is the one call faked here; everything else runs for real.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkspace, DEFAULT_ANSWERS } from './create.js';
import { parseEnvironment, type DeploymentImages } from './deployment.js';
import { PLATFORM_IMAGE_VERSION } from './release-images.js';
import { parseRenderArguments, runRenderCommand } from './render.js';

const RELEASE_DIGEST = `sha256:${'9'.repeat(64)}`;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (command: string, args: readonly string[], options: object) =>
      command === 'docker' && args[0] === 'buildx'
        ? { status: 0, stdout: JSON.stringify({ digest: RELEASE_DIGEST }), stderr: '' }
        : actual.spawnSync(command, args, options),
  };
});

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true })));
});

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const images: DeploymentImages = {
  web: `registry.example/web@${digest('1')}`,
  gateway: `registry.example/gateway@${digest('2')}`,
  runner: `registry.example/runner@${digest('3')}`,
  runtime: `registry.example/runtime@${digest('4')}`,
  postgres: `registry.example/postgres@${digest('5')}`,
  seaweedfs: `registry.example/seaweedfs@${digest('6')}`,
};

async function localProject(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-upgrade-'));
  created.push(parent);
  const target = path.join(parent, 'acme-ai');
  await createWorkspace(target, DEFAULT_ANSWERS, { cloud: 'local', images });
  return target;
}

describe('agent-workspace render --upgrade', () => {
  it('is parsed, and off unless asked for', () => {
    expect(parseRenderArguments([]).upgrade).toBe(false);
    expect(parseRenderArguments(['--upgrade', '--check'])).toMatchObject({
      upgrade: true,
      check: true,
    });
  });

  it('moves the four platform pins to the release, keeps the stores, and prints each move', async () => {
    const target = await localProject();
    const printed: string[] = [];
    await runRenderCommand([target, '--upgrade'], {
      environment: {},
      out: (text) => printed.push(text),
      err: () => undefined,
    });

    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    expect(env['WEB_IMAGE']).toMatch(new RegExp(`/agent-workspace/web@${RELEASE_DIGEST}$`, 'u'));
    expect(env['GATEWAY_IMAGE']).toContain(`@${RELEASE_DIGEST}`);
    expect(env['RUNNER_IMAGE']).toContain(`@${RELEASE_DIGEST}`);
    expect(env['AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK']).toContain(`@${RELEASE_DIGEST}`);
    // A new major of either store is a data migration, so its pin stays.
    expect(env['POSTGRES_IMAGE']).toBe(images.postgres);
    expect(env['SEAWEEDFS_IMAGE']).toBe(images.seaweedfs);

    const output = printed.join('');
    expect(output).toContain(`Moved the platform images to release ${PLATFORM_IMAGE_VERSION}:`);
    expect(output).toContain(`  WEB_IMAGE: ${images.web} -> `);
    expect(output).not.toContain('POSTGRES_PASSWORD');
  });

  it('leaves the pins alone without --upgrade', async () => {
    const target = await localProject();
    await runRenderCommand([target], { environment: {}, out: () => undefined });
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    expect(env['WEB_IMAGE']).toBe(images.web);
  });
});

// @story US-STO-10
describe('agent-workspace render on a project made before AW_STORAGE_URL', () => {
  it("[US-STO-10][api][cli] an existing project's .env keeps its legacy storage lines after render", async () => {
    const target = await localProject();
    const envPath = path.join(target, '.env');
    const legacy = [
      'AW_FILE_STORAGE_ROOT=/var/lib/agent-workspace/files',
      'AW_SKILL_STORAGE_ROOT=/var/lib/agent-workspace/skills',
      'AW_SESSION_TRANSCRIPT_ROOT=/var/lib/agent-workspace/sessions',
      'OBJECT_STORAGE_FORCE_PATH_STYLE=false',
    ];
    const rendered = await readFile(envPath, 'utf8');
    const before = rendered.replace(/^AW_STORAGE_URL=.*$/mu, legacy.join('\n'));
    expect(before).not.toContain('AW_STORAGE_URL=');
    await writeFile(envPath, before);

    await runRenderCommand([target], {
      environment: {},
      out: () => undefined,
      err: () => undefined,
    });

    expect(await readFile(envPath, 'utf8')).toBe(before);
    const compose = await readFile(path.join(target, 'compose.yaml'), 'utf8');
    // Each old root is only forwarded, so a leftover value draws the warning and names no place.
    for (const name of [
      'AW_FILE_STORAGE_ROOT',
      'AW_SKILL_STORAGE_ROOT',
      'AW_SESSION_TRANSCRIPT_ROOT',
    ]) {
      expect(compose.match(new RegExp(`^ +${name}: .*$`, 'gmu'))).toEqual([
        `      ${name}: \${${name}:-}`,
      ]);
    }
  });
});
