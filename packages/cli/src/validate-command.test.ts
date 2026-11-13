import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { renderProfileDocument } from './profile.js';
import { renderEnv } from './render/env.js';
import { ProjectEnvironmentError, runValidateCommand, type ProfileProbes } from './validate.js';

import {
  gcpProfile,
  images,
  localProfile,
  projectWith,
  recordingProbes,
  secrets,
  validationDirectory,
} from './validate.test-support.ts';

describe('validation project names', () => {
  it('refuses a hand-set COMPOSE_PROJECT_NAME too long to scope the session cookie (#394)', async () => {
    const directory = await projectWith(localProfile);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      runValidateCommand([directory], {
        probes: recordingProbes().probes,
        environment: { COMPOSE_PROJECT_NAME: 'x'.repeat(80) },
      }),
    ).rejects.toThrow(/COMPOSE_PROJECT_NAME is 80 characters long/u);
  });

  it('ignores a shell COMPOSE_PROJECT_NAME for a cloud profile, which is no Compose project', async () => {
    const directory = await projectWith(gcpProfile);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (const name of ['agent-workspace', 'x'.repeat(80), 'Not A Name']) {
      await expect(
        runValidateCommand([directory], {
          probes: recordingProbes().probes,
          environment: { COMPOSE_PROJECT_NAME: name },
        }),
      ).resolves.toBeUndefined();
    }
  });
});

describe('validation environment discovery', () => {
  it('runs level 1 on the written profile and reports each store', async () => {
    const directory = await projectWith(localProfile);
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    await runValidateCommand([directory], { probes: recordingProbes().probes, environment: {} });

    expect(written.join('')).toContain('agent-workspace.yaml is valid for cloud local');
    expect(written.join('')).toContain('skipped  identity:');
  });

  // The generator writes `.env` beside `agent-workspace.yaml`, so a caller that supplies no
  // environment must still reach level 2: with an empty one the object store has no credential
  // and could never be probed through the shipped command.
  it('reads the project .env when the caller supplies no environment', async () => {
    const directory = await projectWith(gcpProfile);
    const managed = 'postgres://ops:pw@10.0.0.2:5432/agent_workspace';
    await writeFile(
      path.join(directory, '.env'),
      `${renderEnv({ profile: gcpProfile, secrets, images, dockerGroupId: 999, projectName: 'acme-ai' })}` +
        `DATABASE_URL=${managed}\nGCP_PROJECT=acme-project\n`,
      'utf8',
    );
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const { calls, probes } = recordingProbes();

    await runValidateCommand([directory], { probes });

    // Nothing but the file could have supplied either value: the profile names the stores and
    // holds neither the managed store's URL nor the bucket's credential.
    expect(calls).toEqual([`relational:${managed}`, 'objects:acme-ai-files']);
    expect(written.join('')).toContain('passed  objects:');
    expect(written.join('')).toContain('passed  relational:');
  });
});

/**
 * The regression this pins: `validate` used to probe `postgres` and the object store from the host,
 * which `templates/compose.yaml` makes unreachable by putting both on an `internal: true`
 * network with no published port. The command could therefore never pass on the project the
 * generator had just written — it refused a deployment that was not broken.
 */
it('resolves on a generated local project instead of probing what the host cannot reach', async () => {
  const directory = await projectWith(localProfile);
  await writeFile(
    path.join(directory, '.env'),
    renderEnv({
      profile: localProfile,
      secrets,
      images,
      dockerGroupId: 999,
      projectName: 'acme-ai',
    }),
    'utf8',
  );
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  // Every probe refuses, so a run that reaches one cannot resolve.
  const unreachable = () => Promise.reject(new Error('getaddrinfo ENOTFOUND postgres'));
  const probes: ProfileProbes = {
    relational: unreachable,
    objects: unreachable,
    identity: unreachable,
  };

  await expect(runValidateCommand([directory], { probes })).resolves.toBeUndefined();

  expect(written.join('')).toContain('agent-workspace.yaml is valid for cloud local');
  expect(written.join('')).toContain('skipped  relational: postgres is on the Compose');
  expect(written.join('')).toContain('skipped  objects: seaweedfs is on the Compose');
});
describe('validation input refusals', () => {
  // An operator who edited `.env` by hand needs the file named. The parser names the offending
  // line by number and never quotes it: it may be a value they keep secret.
  it('names the file when the project .env cannot be read as an environment', async () => {
    const directory = await projectWith(localProfile);
    await writeFile(path.join(directory, '.env'), 'DATABASE_URL=postgres://x\nnot an assignment\n');
    const { calls, probes } = recordingProbes();

    const refusal = await runValidateCommand([directory], { probes }).catch(
      (thrown: unknown) => thrown,
    );

    expect(refusal).toBeInstanceOf(ProjectEnvironmentError);
    const error = refusal as ProjectEnvironmentError;
    expect(error.message).toContain(path.join(directory, '.env'));
    expect(error.message).not.toContain('not an assignment');
    expect((error.cause as Error).message).toBe('Invalid .env line 2');
    expect(calls).toEqual([]);
  });

  it('refuses an invalid profile before any probe runs', async () => {
    const directory = await validationDirectory();
    await writeFile(
      path.join(directory, 'agent-workspace.yaml'),
      'cloud: gcp\nstorage:\n  relational: cloud-sql\n  objects: azblob://acme\n  secrets: local-key\nruntime:\n  default: docker\nidentity:\n  bootstrapAdmin: ops@acme.example\n',
      'utf8',
    );
    const { calls, probes } = recordingProbes();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runValidateCommand([directory], { probes, environment: {} })).rejects.toThrow(
      /^agent-workspace\.yaml line 4, column 3: storage\.objects/u,
    );
    expect(calls).toEqual([]);
  });
});

describe('profile document compatibility', () => {
  it('reads a profile written before apiVersion, and says on stderr how to add it', async () => {
    const directory = await validationDirectory();
    const legacy = renderProfileDocument(localProfile).replace(
      'apiVersion: agentworkspace.dev/v1\nkind: Deployment\n',
      '',
    );
    expect(legacy).not.toContain('apiVersion');
    await writeFile(path.join(directory, 'agent-workspace.yaml'), legacy, 'utf8');
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });

    await runValidateCommand([directory], { probes: recordingProbes().probes, environment: {} });

    expect(out.join('')).toContain('agent-workspace.yaml is valid for cloud local');
    expect(err.join('')).toContain('agent-workspace.yaml has no apiVersion');
    expect(err.join('')).toContain('  apiVersion: agentworkspace.dev/v1\n  kind: Deployment\n');
  });

  it('refuses an unknown kind by line, and a duplicate key, before any probe runs', async () => {
    const generated = renderProfileDocument(localProfile);
    for (const [text, expected] of [
      [
        generated.replace('kind: Deployment', 'kind: Workspace'),
        /^agent-workspace\.yaml line 6, column 1: kind must be Deployment/u,
      ],
      [
        `${generated}cloud: aws\n`,
        /^agent-workspace\.yaml line 16, column 1: duplicate key "cloud"/u,
      ],
    ] as const) {
      const directory = await validationDirectory();
      await writeFile(path.join(directory, 'agent-workspace.yaml'), text, 'utf8');
      const { calls, probes } = recordingProbes();

      await expect(runValidateCommand([directory], { probes, environment: {} })).rejects.toThrow(
        expected,
      );
      expect(calls).toEqual([]);
    }
  });
});
