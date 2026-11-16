import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type GeneratorAnswers } from './create.js';
import type { ObjectStorePresence, ProfileProbes } from './validate.js';
import {
  created,
  images,
  cloudImages,
  create,
  captureStdout,
} from './create-test-fixtures.test-support.js';

export function describeCreateValidation(): void {
  describe('create-agent-workspace --validate', () => {
    const composeAnswers: GeneratorAnswers = {
      database: 'PostgreSQL 18',
      storage: 'SeaweedFS',
      runtime: 'docker',
      authentication: 'local administrator',
    };

    /** Every probe is injected, so nothing in this block opens a socket. */
    function recordingProbes(overrides: Partial<ProfileProbes> = {}) {
      const calls: string[] = [];
      const record = (entry: string) => {
        calls.push(entry);
        return Promise.resolve();
      };
      const probes: ProfileProbes = {
        relational: (url) => record(`relational:${url}`),
        // The default double answers for a bucket that is there; `validate.test.ts` covers `missing`.
        objects: (input): Promise<ObjectStorePresence> =>
          record(
            `objects:${input.bucket}:${input.backend === 's3' ? input.accessKeyId : 'adc'}`,
          ).then(() => 'present'),
        identity: (issuer) => record(`identity:${issuer}`),
        ...overrides,
      };
      return { calls, probes };
    }

    const targetIn = async (name: string) => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-validate-'));
      created.push(parent);
      return path.join(parent, name);
    };

    // The Compose project puts both stores on an `internal: true` network with no published port,
    // so the host can never reach them; probing them would make the command fail on its own output.
    it('reports the Compose stores as unreachable from the host, and succeeds, on --cloud local', async () => {
      const target = await targetIn('acme-ai');
      const { calls, probes } = recordingProbes();
      const output = captureStdout();

      await create([target, '--cloud', 'local', '--validate'], {
        images,
        answers: composeAnswers,
        probes,
      });

      expect(calls).toEqual([]);
      expect(output()).toContain("skipped  relational: postgres is on the Compose project's");
      expect(output()).toContain("skipped  objects: seaweedfs is on the Compose project's");
      expect(output()).toContain('docker compose exec postgres pg_isready -U agent_workspace');
      expect(existsSync(path.join(target, 'compose.yaml'))).toBe(true);
    });

    // A cloud store is real from the moment the project exists, and the credentials come from the
    // project's own environment layered over the operator's exports.
    it('probes the real stores on --cloud gcp, with the project environment', async () => {
      const target = await targetIn('acme-ai');
      vi.stubEnv('DATABASE_URL', 'postgres://ops:pw@10.0.0.2:5432/agent_workspace');
      vi.stubEnv('GCP_PROJECT', 'acme-project');
      const { calls, probes } = recordingProbes();
      captureStdout();

      await create([target, '--cloud', 'gcp', '--validate'], {
        images: cloudImages,
        probes,
      });

      expect(calls).toEqual([
        'relational:postgres://ops:pw@10.0.0.2:5432/agent_workspace',
        // The bucket is the profile's; ADC supplies the workload identity.
        'objects:acme-ai-files:adc',
      ]);
    });

    it('fails with the project already written when a store genuinely refuses', async () => {
      const target = await targetIn('acme-ai');
      vi.stubEnv('DATABASE_URL', 'postgres://ops:pw@10.0.0.2:5432/agent_workspace');
      const { probes } = recordingProbes({
        relational: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.2:5432')),
      });
      captureStdout();

      const refusal = await create([target, '--cloud', 'gcp', '--validate'], {
        images: cloudImages,
        probes,
      }).catch((thrown: unknown) => thrown);

      expect(refusal).toBeInstanceOf(Error);
      const error = refusal as Error;
      expect(error.message).toContain('the relational store did not answer');
      expect(error.message).toContain(`The project was written to ${target}`);
      // The driver's own text names the host; it stays in `cause`, as everywhere else.
      expect(error.message).not.toContain('ECONNREFUSED');
      expect(existsSync(path.join(target, 'agent-workspace.yaml'))).toBe(true);
    });
  });
}
