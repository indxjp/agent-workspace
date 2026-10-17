import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => childProcess);

afterEach(() => {
  childProcess.spawn.mockReset();
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

describe('spawnTool', () => {
  it('spawns the tool without a shell, with an argument array, in the given directory', async () => {
    const child = fakeChild();
    childProcess.spawn.mockReturnValue(child);
    const { spawnTool } = await import('./runner.js');
    const env = { PATH: '/usr/bin' };

    const running = spawnTool({
      tool: 'terraform',
      args: ['plan', '-input=false'],
      cwd: '/p',
      env,
    });
    child.stdout.write('planned');
    child.stderr.write('warned');
    child.stdout.end();
    child.stderr.end();
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 2);

    await expect(running).resolves.toEqual({ status: 2, stdout: 'planned', stderr: 'warned' });
    expect(childProcess.spawn).toHaveBeenCalledWith('terraform', ['plan', '-input=false'], {
      cwd: '/p',
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('rejects with the spawn error, which isMissingTool recognises', async () => {
    const child = fakeChild();
    childProcess.spawn.mockReturnValue(child);
    const { isMissingTool, spawnTool } = await import('./runner.js');

    const running = spawnTool({ tool: 'helm', args: [], cwd: '/p', env: {} });
    const error = Object.assign(new Error('spawn helm ENOENT'), { code: 'ENOENT' });
    child.emit('error', error);

    await expect(running).rejects.toBe(error);
    expect(isMissingTool(error)).toBe(true);
    expect(isMissingTool(new Error('other'))).toBe(false);
  });
});
