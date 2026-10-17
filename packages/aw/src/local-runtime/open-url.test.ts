import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { keyConsole, openCommands, openUrl } from './open-url.js';

const URL_TO_OPEN = 'https://console.anthropic.com/settings/keys';

/** A spawn double: the programs in `missing` fail to start, every other one starts. */
function spawnDouble(missing: readonly string[]) {
  const started: string[][] = [];
  const spawn = (command: string, args: string[]): ChildProcess => {
    started.push([command, ...args]);
    const child = Object.assign(new EventEmitter(), { unref: () => undefined });
    setImmediate(() => child.emit(missing.includes(command) ? 'error' : 'spawn'));
    return child as unknown as ChildProcess;
  };
  return { spawn, started };
}

describe('openUrl (UX-B)', () => {
  it('names the console for the providers it knows', () => {
    expect(keyConsole('ANTHROPIC_API_KEY')?.url).toBe(URL_TO_OPEN);
    expect(keyConsole('OPENAI_API_KEY')?.url).toBe('https://platform.openai.com/api-keys');
    expect(keyConsole('OTHER_KEY')).toBeUndefined();
  });

  it('passes the URL as one argument, per platform', () => {
    expect(openCommands(URL_TO_OPEN, 'win32', false)).toEqual([
      ['rundll32', 'url.dll,FileProtocolHandler', URL_TO_OPEN],
    ]);
    expect(openCommands(URL_TO_OPEN, 'darwin', false)).toEqual([['open', URL_TO_OPEN]]);
    expect(openCommands(URL_TO_OPEN, 'linux', false)).toEqual([['xdg-open', URL_TO_OPEN]]);
  });

  it('on WSL tries wslview, then cmd.exe on PATH and by its Windows path, then xdg-open (BH061-024)', () => {
    expect(openCommands(URL_TO_OPEN, 'linux', true).map(([command]) => command)).toEqual([
      'wslview',
      'cmd.exe',
      '/mnt/c/Windows/System32/cmd.exe',
      'xdg-open',
    ]);
    const hostile = 'https://example.com/?a=1&calc';
    expect(openCommands(hostile, 'linux', true).map(([command]) => command)).toEqual([
      'wslview',
      'xdg-open',
    ]);
  });

  it('gives cmd.exe start an empty title as its own argument', () => {
    const cmd = openCommands(URL_TO_OPEN, 'linux', true).find(([command]) => command === 'cmd.exe');
    expect(cmd).toEqual(['cmd.exe', '/c', 'start', '', URL_TO_OPEN]);
  });

  it('falls through a missing program and reports whether one started', async () => {
    const wsl = spawnDouble(['wslview', 'cmd.exe']);
    expect(await openUrl(URL_TO_OPEN, { platform: 'linux', wsl: true, spawn: wsl.spawn })).toBe(
      true,
    );
    expect(wsl.started.map(([command]) => command)).toEqual([
      'wslview',
      'cmd.exe',
      '/mnt/c/Windows/System32/cmd.exe',
    ]);
    const none = spawnDouble(['xdg-open']);
    expect(await openUrl(URL_TO_OPEN, { platform: 'linux', wsl: false, spawn: none.spawn })).toBe(
      false,
    );
  });

  it('never opens anything but an http(s) URL', async () => {
    const { spawn, started } = spawnDouble([]);
    expect(await openUrl('file:///etc/passwd', { platform: 'linux', spawn })).toBe(false);
    expect(started).toEqual([]);
  });
});
