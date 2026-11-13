import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeConnection, runRequestBody } from './server-fixture.test-support.js';
import { createRunnerServer } from './server.js';
// @story US-STO-06
export const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

/** POST one `/run` that grants `reports/q3.txt` by reference; report the answer and any start. */
export async function runWithReference(
  onDisk: string | null,
  reference: { readonly size: number; readonly sha256: string },
): Promise<{ readonly status: number; readonly body: unknown; readonly started: number }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'w3-runner-reference-'));
  if (onDisk !== null) {
    await mkdir(path.join(cwd, 'reports'));
    await writeFile(path.join(cwd, 'reports', 'q3.txt'), onDisk);
  }
  let started = 0;
  const server = createRunnerServer({
    startAgent: () => {
      started += 1;
      return Promise.resolve({ ok: true, connection: fakeConnection([]) });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(runRequestBody(
          'aaaaaaaa-1111-4111-8111-111111111111',
          'bbbbbbbb-2222-4222-8222-222222222222',
        ) as Record<string, unknown>),
        cwd,
        resources: {
          files: [{ kind: 'file', path: 'reports/q3.txt', access: 'read', ...reference }],
          skills: [],
        },
      }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: response.status === 200 ? text : (JSON.parse(text) as unknown),
      started,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
}

/** POST one `/run` that grants skill `support` by reference; report the answer, start and inbox. */
export async function runWithSkillReference(
  onDisk: string | null,
  reference: { readonly size: number; readonly sha256: string },
) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'w3-runner-skill-reference-'));
  if (onDisk !== null) {
    await mkdir(path.join(cwd, '.aw-inbox', 'skills', 'support'), { recursive: true });
    await writeFile(path.join(cwd, '.aw-inbox', 'skills', 'support', 'SKILL.md'), onDisk);
  }
  const started: unknown[] = [];
  const server = createRunnerServer({
    startAgent: (request) => {
      started.push(request.resources?.skills);
      return Promise.resolve({ ok: true, connection: fakeConnection([]) });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(runRequestBody(
          'aaaaaaaa-1111-4111-8111-111111111111',
          'bbbbbbbb-2222-4222-8222-222222222222',
        ) as Record<string, unknown>),
        cwd,
        resources: {
          files: [],
          skills: [{ name: 'support', files: [{ path: 'SKILL.md', ...reference }] }],
        },
      }),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      started,
      inboxLeft: await stat(path.join(cwd, '.aw-inbox')).then(
        () => true,
        () => false,
      ),
      cwd,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * POST one `/run` whose resources carry inline bytes; report the answer and whether an engine started.
 * `granted` is written under `cwd` first, so the reference itself is valid and only the inline bytes can refuse it.
 */
export async function runWithInlineBytes(
  granted: { readonly at: string; readonly body: string },
  resources: unknown,
) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'w3-runner-inline-'));
  await mkdir(path.dirname(path.join(cwd, granted.at)), { recursive: true });
  await writeFile(path.join(cwd, granted.at), granted.body);
  let started = 0;
  const server = createRunnerServer({
    startAgent: () => {
      started += 1;
      return Promise.resolve({ ok: true, connection: fakeConnection([]) });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(runRequestBody(
          'aaaaaaaa-1111-4111-8111-111111111111',
          'bbbbbbbb-2222-4222-8222-222222222222',
        ) as Record<string, unknown>),
        cwd,
        resources,
      }),
    });
    return { status: response.status, text: await response.text(), started };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
}
export interface ReferenceGates {
  readonly verifyGate: { hold: Promise<void>; after: (cwd: string) => Promise<void> };
  readonly inboxRemoval: { fail: boolean };
}
