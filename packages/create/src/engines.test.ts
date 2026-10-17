import { describe, expect, it } from 'vitest';

import { nodeTooOld, windowsNodeInWsl } from './engines.js';

describe('nodeTooOld', () => {
  it.each(['24.0.0', '24.9.1', '25.1.0', '30.0.0'])('lets Node %s through', (version) => {
    expect(nodeTooOld(version)).toBeNull();
  });

  it.each(['23.11.0', '22.12.0', '20.19.5', '18.20.4', '9.0.0'])(
    'tells Node %s to install and use Node 24, in one line (BH061-068)',
    (version) => {
      expect(nodeTooOld(version)).toBe(
        `error: Agent Workspace needs Node 24 or newer; you have v${version}. ` +
          'Install it from https://nodejs.org, or with nvm: nvm install 24 && nvm use 24',
      );
    },
  );
});

describe('windowsNodeInWsl (BH061-009)', () => {
  it.each([
    ['C:\\Windows', '\\\\wsl.localhost\\Ubuntu\\home\\you'],
    ['C:\\Windows', '\\\\wsl$\\Ubuntu\\home\\you'],
    ['\\\\WSL.LOCALHOST\\Ubuntu\\home\\you', undefined],
  ])('names the WSL trap for Windows Node in %s (started in %s)', (cwd, initCwd) => {
    expect(windowsNodeInWsl('win32', cwd, initCwd)).toMatch(
      /^error: this is Windows Node\.js running inside WSL/u,
    );
  });

  it('says nothing on Linux, or for Windows Node in a Windows directory', () => {
    expect(windowsNodeInWsl('linux', '/home/you', '/home/you')).toBeNull();
    expect(windowsNodeInWsl('win32', 'C:\\Users\\you', 'C:\\Users\\you')).toBeNull();
    expect(windowsNodeInWsl('win32', 'C:\\Users\\you', undefined)).toBeNull();
  });
});
