import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import { defineAgent, defineSurface, toAgentVersionBody } from '@indx-workspace/sdk/define';
import { describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { IDS, runCli } from '../testing.js';

import {
  ORIGINAL,
  PROJECT_SOURCE,
  bodyWith,
  created,
  emptyServer,
  exportTs,
  markdown,
  project,
  server,
  versionOf,
  versioned,
} from './agents-export.test-support.js';

// `aw check` and `aw push` run the real project loader, a forked Node process.
vi.setConfig({ testTimeout: 30_000 });

describe('aw agents export --format ts', () => {
  it('[US-BLD-06][api][cli] writes files that pass aw check and push back to the same body', async () => {
    const source = await created();
    const out = await project({ 'agent-workspace.yaml': PROJECT_SOURCE });

    const exported = await runCli(['agents', 'export', IDS.agent, '--format', 'ts', '--out', out], {
      route: server(source),
    });
    expect(exported.stderr).toBe('');
    expect(exported.code).toBe(EXIT_CODE.ok);
    expect(exported.stdout).toBe(
      `wrote ${path.join(out, 'agents', 'summariser.ts')}\n` +
        `wrote ${path.join(out, 'agents', 'summariser.md')}\n` +
        'Next: aw check && aw push\n',
    );
    expect(await readFile(path.join(out, 'agents', 'summariser.md'), 'utf8')).toBe(
      ORIGINAL.definition.agent.instructions,
    );

    // A workspace that has not got the agent yet: the push creates it from the exported files.
    const fresh = emptyServer();
    const checked = await runCli(['check'], { cwd: out, route: server(fresh) });
    expect(checked.stderr).toBe('');
    expect(checked.code).toBe(EXIT_CODE.ok);
    const pushed = await runCli(['push', '--yes'], { cwd: out, route: server(fresh) });
    expect(pushed.code).toBe(EXIT_CODE.ok);
    expect(fresh.versions).toHaveLength(1);
    expect(AgentVersionBodySchema.parse(fresh.versions[0]?.body)).toStrictEqual(ORIGINAL);

    // The workspace that holds the original sees the exported files as the same definition.
    const again = await runCli(['push'], { cwd: out, route: server(source) });
    expect(again.code).toBe(EXIT_CODE.ok);
    expect(again.stdout).toContain('unchanged');
    expect(source.versions).toHaveLength(1);
  });

  it('refuses to overwrite, listing the files, unless --force', async () => {
    const out = await project({ 'agents/summariser.ts': 'old ts', 'agents/summariser.md': 'old' });
    const state = versioned(['v1'], 1);
    const refused = await exportTs(out, state);
    expect(refused.code).toBe(EXIT_CODE.problem);
    expect(refused.stderr).toContain(
      `${path.join(out, 'agents', 'summariser.ts')}, ${markdown(out)}`,
    );
    expect(refused.stderr).toContain('--force');
    expect(await readFile(markdown(out), 'utf8')).toBe('old');

    const forced = await exportTs(out, state, '--force');
    expect(forced.code).toBe(EXIT_CODE.ok);
    expect(await readFile(markdown(out), 'utf8')).toBe('v1');
  });

  it('writes the version --agent-version names, and refuses one the agent does not have', async () => {
    const out = await project();
    const state = versioned(['v1', 'v2'], 2);
    expect((await exportTs(out, state, '--agent-version', '1')).code).toBe(EXIT_CODE.ok);
    expect(await readFile(markdown(out), 'utf8')).toBe('v1');

    const empty = await project();
    const missing = await exportTs(empty, state, '--agent-version', '3');
    expect(missing.code).toBe(EXIT_CODE.problem);
    expect(missing.stderr).toContain('has no version 3');
    await expect(readFile(markdown(empty), 'utf8')).rejects.toThrow();
  });

  it('writes the version local names, else the newest, and refuses an agent with none', async () => {
    const pointed = await project();
    await exportTs(pointed, versioned(['v1', 'v2'], 1));
    expect(await readFile(markdown(pointed), 'utf8')).toBe('v1');

    const unpointed = await project();
    await exportTs(unpointed, versioned(['v1', 'v2'], null));
    expect(await readFile(markdown(unpointed), 'utf8')).toBe('v2');

    const none = await exportTs(await project(), versioned([], null));
    expect(none.code).toBe(EXIT_CODE.problem);
    expect(none.stderr).toContain('no saved version');
  });

  it('names the path of a connector it cannot declare, and writes nothing', async () => {
    const out = await project();
    const run = await exportTs(out, await created());
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('definition.resources.connectors.0');
    expect(run.stderr).toContain('connectors: in agent-workspace.yaml');
    await expect(readFile(markdown(out), 'utf8')).rejects.toThrow();
  });

  it('does not offer a connectors: entry as the fix for a code tool', async () => {
    const out = await project();
    const plain = bodyWith('x');
    const body = AgentVersionBodySchema.parse({
      ...plain,
      definition: {
        ...plain.definition,
        resources: { ...plain.definition.resources, connectors: ['aw-dev-tools'] },
      },
    });
    const run = await exportTs(out, await created(body));
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('definition.resources.connectors.0');
    expect(run.stderr).toContain('an mcp() connector must be declared');
    expect(run.stderr).toContain('module and code tools cannot be exported yet');
    await expect(readFile(markdown(out), 'utf8')).rejects.toThrow();
  });

  it('names the path of a surface it cannot write as code, and writes nothing', async () => {
    const out = await project();
    const agent = defineAgent({ name: 'summariser', instructions: 'x' });
    const surface = defineSurface({ name: 'desk', agent: 'summariser', title: 'Desk' });
    const body = AgentVersionBodySchema.parse(toAgentVersionBody(agent, { surfaces: [surface] }));
    const run = await exportTs(out, await created(body));
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('surfaces.0');
    await expect(readFile(markdown(out), 'utf8')).rejects.toThrow();
  });

  it('refuses an agent whose name is not a project name, and writes nothing', async () => {
    const out = await project();
    const state = emptyServer();
    state.versions.push(
      versionOf(state, { body: bodyWith('x', 'Bad Name'), summary: 's', via: 'api' }),
    );
    const run = await exportTs(out, state);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('body.definition.agent.name');
    await expect(readFile(path.join(out, 'agents', 'Bad Name.md'), 'utf8')).rejects.toThrow();
  });

  it('refuses --out, --force and --agent-version without --format ts, and an unknown format, before any request', async () => {
    for (const argv of [
      ['--out', '.'],
      ['--force'],
      ['--agent-version', '1'],
      ['--format', 'json', '--force'],
      ['--format', 'yaml'],
    ]) {
      const run = await runCli(['agents', 'export', IDS.agent, ...argv], {
        route: server(emptyServer()),
      });
      expect(run.code, argv.join(' ')).toBe(EXIT_CODE.usage);
      expect(run.calls, argv.join(' ')).toEqual([]);
    }
  });

  it('writes under the current directory by default', async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, 'agents'));
    await writeFile(path.join(cwd, 'agents', 'other.md'), 'kept');
    const run = await runCli(['agents', 'export', IDS.agent, '--format', 'ts'], {
      cwd,
      route: server(versioned(['v1'], 1)),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(await readFile(markdown(cwd), 'utf8')).toBe('v1');
    expect(await readFile(path.join(cwd, 'agents', 'other.md'), 'utf8')).toBe('kept');
  });

  it('leaves no temporary directory after a successful export, with or without --force', async () => {
    const out = await project();
    const state = versioned(['v1'], 1);
    expect((await exportTs(out, state)).code).toBe(EXIT_CODE.ok);
    expect((await exportTs(out, state, '--force')).code).toBe(EXIT_CODE.ok);
    expect(await readdir(out)).toEqual(['agents']);
    expect((await readdir(path.join(out, 'agents'))).sort()).toEqual([
      'summariser.md',
      'summariser.ts',
    ]);
  });
});
