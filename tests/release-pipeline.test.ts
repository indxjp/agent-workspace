import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Wave 6 release pipeline', () => {
  it('refuses to publish only one architecture', () => {
    const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\sh.exe' : 'sh';
    const result = spawnSync(
      shell,
      ['infra/release/build-and-push.sh', '--platform', 'linux/amd64'],
      { encoding: 'utf8', env: { ...process.env, REGISTRY: 'example.invalid' } },
    );
    if (result.error) throw result.error;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('linux/arm64');
  });
  it('refuses an unresolved tag instead of inventing a digest', () => {
    const result = spawnSync(
      process.execPath,
      ['infra/release/resolve-digest.mjs', 'invalid.invalid/agent-workspace/runtime:missing'],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    // The registry's or docker's own refusal, naming the reference or docker; never a crash.
    expect(result.stderr).toMatch(/invalid\.invalid|docker/u);
    expect(result.stderr).not.toMatch(/^\s+at /mu);
  }, 20_000);
  it('labels every published image with its release version (BH061-059)', () => {
    const script = readFileSync('infra/release/build-and-push.sh', 'utf8');
    expect(script).toContain('version_label="org.opencontainers.image.version=$tag"');
    expect(script.match(/--label "\$version_label"/gu)).toHaveLength(2);
  });
  it('keeps agent instructions and repository tooling out of every image (BH061-059)', () => {
    const ignored = readFileSync('.dockerignore', 'utf8').split('\n');
    for (const entry of [
      'AGENTS.md',
      'CLAUDE.md',
      'formal/',
      '*.Dockerfile',
      'vitest*.config.ts',
    ]) {
      expect(ignored, entry).toContain(entry);
    }
  });
  it('keeps nested env files and Terraform variables, plans and state out of every image', () => {
    const ignored = readFileSync('.dockerignore', 'utf8').split('\n');
    for (const entry of ['**/.env', '**/.env.*', '**/*.tfvars', '**/*.tfplan', '**/*.tfstate']) {
      expect(ignored, entry).toContain(entry);
    }
  });
});
