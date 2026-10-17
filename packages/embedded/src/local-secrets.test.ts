import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyLocalSecrets,
  ensureLocalSecrets,
  ensureRuntimeDirectory,
  LOCAL_SECRETS_DIRECTORY,
  LOCAL_SECRETS_FILE,
  LocalSecretsError,
  LocalSecretsSchema,
  RUNTIME_DIRECTORY,
} from './local-secrets.js';

let projectDir = '';

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'embedded-secrets-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function secretsFile(): string {
  return path.join(projectDir, RUNTIME_DIRECTORY, LOCAL_SECRETS_DIRECTORY, LOCAL_SECRETS_FILE);
}

describe('ensureLocalSecrets', () => {
  it('generates valid secrets on first start and writes them owner-only', () => {
    const first = ensureLocalSecrets(projectDir);
    expect(first.created).toBe(true);
    expect(first.path).toBe(secretsFile());
    expect(LocalSecretsSchema.safeParse(first.secrets).success).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(first.path).mode & 0o777).toBe(0o600);
    }
  });

  it('reuses the file byte for byte on a later start', () => {
    const first = ensureLocalSecrets(projectDir);
    const bytes = readFileSync(first.path);
    const second = ensureLocalSecrets(projectDir);
    expect(second.created).toBe(false);
    expect(second.secrets).toStrictEqual(first.secrets);
    expect(readFileSync(second.path).equals(bytes)).toBe(true);
  });

  it("keeps the file out of the run workspaces' ancestors, moving one left at the old place", () => {
    const generated = ensureLocalSecrets(projectDir);
    const legacy = path.join(projectDir, RUNTIME_DIRECTORY, LOCAL_SECRETS_FILE);
    renameSync(generated.path, legacy);

    const moved = ensureLocalSecrets(projectDir);
    expect(moved.created).toBe(false);
    expect(moved.path).toBe(secretsFile());
    expect(moved.secrets).toStrictEqual(generated.secrets);
    expect(existsSync(legacy)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('tightens a looser mode to 0600', async () => {
    const { chmodSync } = await import('node:fs');
    const first = ensureLocalSecrets(projectDir);
    chmodSync(first.path, 0o644);
    ensureLocalSecrets(projectDir);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['not JSON', 'SESSION_SECRET=hunter2-super-secret'],
    ['a schema mismatch', JSON.stringify({ SESSION_SECRET: 'hunter2-super-secret' })],
  ])('refuses %s without echoing the contents', (_name, contents) => {
    mkdirSync(path.dirname(secretsFile()), { recursive: true });
    writeFileSync(path.join(projectDir, RUNTIME_DIRECTORY, '.gitignore'), '*\n');
    writeFileSync(secretsFile(), contents);
    let caught: unknown;
    try {
      ensureLocalSecrets(projectDir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalSecretsError);
    if (!(caught instanceof LocalSecretsError)) return;
    expect(caught.code).toBe('local_secrets_invalid');
    expect(caught.message).toContain(secretsFile());
    expect(caught.message).not.toContain('hunter2');
    expect(caught.cause).toBeUndefined();
  });

  it('writes the .gitignore before any other file in the runtime directory', async () => {
    const directory = path.join(projectDir, RUNTIME_DIRECTORY);
    mkdirSync(directory);
    const seen: string[] = [];
    const watcher = watch(directory, (_event, name) => {
      if (name !== null && !seen.includes(name)) seen.push(name);
    });
    try {
      ensureLocalSecrets(projectDir);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      watcher.close();
    }
    expect(seen[0]).toBe('.gitignore');
    expect(readFileSync(path.join(directory, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('accepts an existing .gitignore with a "*" line and refuses one without', () => {
    const directory = path.join(projectDir, RUNTIME_DIRECTORY);
    mkdirSync(directory);
    writeFileSync(path.join(directory, '.gitignore'), '# mine\r\n*\r\n');
    expect(ensureRuntimeDirectory(projectDir)).toBe(directory);

    writeFileSync(path.join(directory, '.gitignore'), 'storage/\n');
    expect(() => ensureLocalSecrets(projectDir)).toThrow(
      expect.objectContaining({ code: 'runtime_gitignore_invalid' }),
    );
  });

  it.each(['*\n!local-secrets.json\n', '*\r\n  !*.json\r\n'])(
    'refuses a .gitignore whose negation line would un-ignore the secrets (%j), writing no secrets',
    (content) => {
      const directory = path.join(projectDir, RUNTIME_DIRECTORY);
      mkdirSync(directory);
      writeFileSync(path.join(directory, '.gitignore'), content);
      expect(() => ensureLocalSecrets(projectDir)).toThrow(
        expect.objectContaining({ code: 'runtime_gitignore_invalid' }),
      );
      expect(() => statSync(secretsFile())).toThrow();
    },
  );

  it('refuses a runtime directory that is a file, naming the path', () => {
    const runtimePath = path.join(projectDir, RUNTIME_DIRECTORY);
    writeFileSync(runtimePath, 'not a directory');
    let caught: unknown;
    try {
      ensureLocalSecrets(projectDir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalSecretsError);
    if (!(caught instanceof LocalSecretsError)) return;
    expect(caught.code).toBe('runtime_directory_invalid');
    expect(caught.message).toContain(runtimePath);
  });
});

describe('applyLocalSecrets', () => {
  it('fills only unset keys, so the environment and .env win', () => {
    const { secrets } = ensureLocalSecrets(projectDir);
    const env: Record<string, string | undefined> = { SESSION_SECRET: 'from-dot-env' };
    const applied = applyLocalSecrets(env, secrets);
    expect(env['SESSION_SECRET']).toBe('from-dot-env');
    expect(env['MASTER_ENCRYPTION_KEY']).toBe(secrets.MASTER_ENCRYPTION_KEY);
    expect(applied).toStrictEqual([
      'MASTER_ENCRYPTION_KEY',
      'GATEWAY_TOKEN_SECRET',
      'BOOTSTRAP_ADMIN_PASSWORD',
    ]);
  });

  it('treats a blank value, such as the SESSION_SECRET= line .env.example ships, as unset', () => {
    const { secrets } = ensureLocalSecrets(projectDir);
    const env: Record<string, string | undefined> = {
      SESSION_SECRET: '',
      MASTER_ENCRYPTION_KEY: '  ',
    };
    const applied = applyLocalSecrets(env, secrets);
    expect(env['SESSION_SECRET']).toBe(secrets.SESSION_SECRET);
    expect(env['MASTER_ENCRYPTION_KEY']).toBe(secrets.MASTER_ENCRYPTION_KEY);
    expect(applied).toContain('SESSION_SECRET');
    expect(applied).toContain('MASTER_ENCRYPTION_KEY');
  });

  it('lets a .env file loaded first win over the secrets file', () => {
    const { secrets } = ensureLocalSecrets(projectDir);
    const env: Record<string, string | undefined> = {};
    const dotEnv = path.join(projectDir, '.env');
    writeFileSync(dotEnv, 'BOOTSTRAP_ADMIN_PASSWORD=chosen-in-dot-env\n');
    Object.assign(env, parseEnv(readFileSync(dotEnv, 'utf8')));
    const applied = applyLocalSecrets(env, secrets);
    expect(env['BOOTSTRAP_ADMIN_PASSWORD']).toBe('chosen-in-dot-env');
    expect(applied).not.toContain('BOOTSTRAP_ADMIN_PASSWORD');
  });
});

describe('the runtime directory in a fresh `aw init` project', () => {
  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: projectDir, encoding: 'utf8' });
  }

  it('keeps the secrets out of git without a root .gitignore', () => {
    git('init', '--quiet');
    writeFileSync(path.join(projectDir, 'agent-workspace.yaml'), 'name: demo\n');
    mkdirSync(path.join(projectDir, 'agents'));
    writeFileSync(path.join(projectDir, 'agents', 'assistant.ts'), 'export {};\n');
    mkdirSync(path.join(projectDir, 'surfaces'));
    writeFileSync(path.join(projectDir, 'surfaces', 'main.ts'), 'export {};\n');

    ensureLocalSecrets(projectDir);

    const ignored = spawnSync(
      'git',
      ['check-ignore', '-q', `${RUNTIME_DIRECTORY}/${LOCAL_SECRETS_FILE}`],
      { cwd: projectDir },
    );
    expect(ignored.status).toBe(0);
    const status = git('status', '--porcelain', '--untracked-files=all');
    expect(status.split('\n').filter((line) => line.includes(RUNTIME_DIRECTORY))).toStrictEqual([]);
    expect(status).toContain('agent-workspace.yaml');
  });
});
