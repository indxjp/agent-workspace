import { describe, expect, it } from 'vitest';

import {
  detectHostCapabilities,
  type CommandProbe,
  type CommandResult,
} from './host-capabilities.js';

const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = 'not found'): CommandResult => ({ status: 1, stdout: '', stderr });

function probe(results: Readonly<Record<string, CommandResult>>): CommandProbe {
  return (command, args) => results[[command, ...args].join(' ')] ?? fail();
}

describe('detectHostCapabilities', () => {
  it('defaults to local on a Linux host with bwrap, socat and rg but no Docker', () => {
    const asked: string[] = [];
    const base = probe({
      'sh -c command -v bwrap && command -v socat && command -v rg': ok('/usr/bin/rg'),
    });
    const capabilities = detectHostCapabilities('linux', (command, args) => {
      asked.push([command, ...args].join(' '));
      return base(command, args);
    });
    expect(capabilities.defaultDriver).toBe('local');
    expect(capabilities.drivers.map(({ id }) => id)).toEqual(['docker', 'kubernetes', 'local']);
    expect(asked.join('\n')).not.toMatch(/bwrap|socat|rg/);
  });

  it('uses Docker when the daemon is reachable', () => {
    const capabilities = detectHostCapabilities(
      'linux',
      probe({ 'docker version --format {{.Server.Version}}': ok('29.0') }),
    );
    expect(capabilities.defaultDriver).toBe('docker');
  });

  it('uses Docker on Windows when the daemon is reachable', () => {
    const capabilities = detectHostCapabilities(
      'win32',
      probe({ 'docker version --format {{.Server.Version}}': ok('29.0') }),
    );
    expect(capabilities.defaultDriver).toBe('docker');
    expect(capabilities.drivers[0]).toMatchObject({ id: 'docker', available: true });
  });

  it('reports stale Kubernetes state and falls back to local explicitly', () => {
    const capabilities = detectHostCapabilities(
      'win32',
      probe({ 'kubectl config current-context': ok('stale-context') }),
    );
    expect(capabilities.defaultDriver).toBe('local');
    expect(capabilities.drivers.find(({ id }) => id === 'kubernetes')?.reason).toContain(
      'not reachable',
    );
  });

  it('never treats an unsupported platform as a plausible local host', () => {
    expect(() => detectHostCapabilities('aix')).toThrow(/unsupported host platform/);
  });
});
