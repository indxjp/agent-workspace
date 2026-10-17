import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { refusalText, runAsProcess } from './cli-failure.js';
import { defaultProfile } from './profile-defaults.js';
import { renderProfileDocument } from './profile.js';
import {
  ProbeRefusedError,
  runValidateCommand,
  type ObjectStorePresence,
  type ProfileProbes,
} from './validate.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true })));
});

/** The connection string a driver error routinely quotes, which is why `cause` exists at all. */
const SECRET_URL = 'postgres://u:SUPERSECRET@h/db';

async function projectNamingAManagedStore(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-cli-refusal-'));
  created.push(parent);
  const project = path.join(parent, 'acme-ai');
  await mkdir(project);
  await writeFile(
    path.join(project, 'agent-workspace.yaml'),
    renderProfileDocument(defaultProfile({ cloud: 'gcp', projectName: 'acme-ai' })),
    'utf8',
  );
  return project;
}

/** Every probe is injected, so nothing here opens a socket. */
function probesRefusingWith(cause: Error): ProfileProbes {
  return {
    relational: () => Promise.reject(cause),
    objects: (): Promise<ObjectStorePresence> => Promise.resolve('present'),
    identity: () => Promise.resolve(),
  };
}

describe('what a refused command writes as a process', () => {
  /**
   * The guarantee `validate.ts`, ADR-0055 and `packages/cli/README.md` all state, at the level it
   * is actually observable: a refusal reaches stderr as its own message and nothing else. Before
   * this, neither entry point caught anything, so Node's default handler printed the rejected
   * top-level `await` — the whole `cause` chain, driver text and stack included.
   */
  it('prints the refusal and never the connection string its cause quotes', async () => {
    const project = await projectNamingAManagedStore();
    const written: string[] = [];

    const code = await runAsProcess(
      () =>
        runValidateCommand([project], {
          environment: { DATABASE_URL: SECRET_URL },
          probes: probesRefusingWith(
            new Error(`password authentication failed for connection ${SECRET_URL}`),
          ),
        }),
      (chunk) => written.push(chunk),
    );

    const stderr = written.join('');
    expect(code).toBe(1);
    expect(stderr).toBe(
      'agent-workspace.yaml: the relational store did not answer — ' +
        'the connection was refused or timed out\n',
    );
    expect(stderr).not.toContain('SUPERSECRET');
    expect(stderr).not.toContain('postgres://');
  });

  /**
   * `create --validate` re-wraps the refusal with a second `{ cause }` so it can say the project
   * was written, which is what makes the chain two levels deep. Only the outermost message is
   * printed, so the depth does not matter — and that is the property worth pinning.
   */
  it('prints only the outermost message of a two-level cause chain', async () => {
    const driver = new Error(`password authentication failed for connection ${SECRET_URL}`);
    const refusal = new ProbeRefusedError('relational', 'the connection was refused', driver);
    const wrapped = new Error(
      `${refusal.message}\nThe project was written to /tmp/acme-ai; fix the store, then re-run.`,
      { cause: refusal },
    );
    const written: string[] = [];

    const code = await runAsProcess(
      () => Promise.reject(wrapped),
      (chunk) => written.push(chunk),
    );

    expect(code).toBe(1);
    expect(written.join('')).toBe(`${wrapped.message}\n`);
    expect(written.join('')).not.toContain('SUPERSECRET');
  });

  // A dependency may reject with anything, and the handler that exists to keep provider text out
  // of a log must not start reading an unknown object for a `message` of its own.
  it('stringifies a thrown non-Error rather than inspecting it', () => {
    expect(refusalText('refused')).toBe('refused');
    expect(refusalText(undefined)).toBe('undefined');
    expect(refusalText(new Error('the objects store did not answer'))).toBe(
      'the objects store did not answer',
    );
  });

  it('writes nothing and exits 0 when the command succeeds', async () => {
    const written: string[] = [];

    expect(
      await runAsProcess(
        () => Promise.resolve(),
        (chunk) => written.push(chunk),
      ),
    ).toBe(0);
    expect(written).toEqual([]);
  });

  it('keeps the exit code a command that finished without succeeding left behind (BH061-014)', async () => {
    const before = process.exitCode;
    try {
      const code = await runAsProcess(() => {
        process.exitCode = 130;
        return Promise.resolve();
      });
      expect(code).toBe(130);
    } finally {
      process.exitCode = before;
    }
  });
});
