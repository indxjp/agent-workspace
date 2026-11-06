import { describe, expect, it, vi } from 'vitest';
import { pushVercelSandboxImage } from './journey.e2e.mjs';
import './journey-test-fixtures.js';

describe('the lightweight journey lanes (issue #832)', () => {
  describe('pushVercelSandboxImage', () => {
    const TOKEN = 'vcp_SENTINEL_token_0123456789';
    const DIGEST = 'a'.repeat(64);
    const PUSHED = 'b'.repeat(64);
    const reference = `localhost:5000/agent-runtime@sha256:${DIGEST}`;
    const tagged = `vcr.vercel.com/acme/aw-lj-manager/agent-workspace-runtime:sha256-${DIGEST}`;
    const options = { reference, team: 'team_x', token: TOKEN, project: 'aw-lj', pollMs: 0 };

    function fixture(
      sandboxAnswers: { status: number; text: string }[],
      projectStatus = 200,
      inspected = `${tagged.split(':')[0] ?? ''}@sha256:${PUSHED}\n`,
    ) {
      const commands: { line: string; input?: string; env?: NodeJS.ProcessEnv }[] = [];
      const requests: string[] = [];
      const run = vi.fn(
        (
          command: string,
          args: readonly string[],
          opts: { env?: NodeJS.ProcessEnv; input?: string },
        ) => {
          commands.push({
            line: [command, ...args].join(' '),
            ...(opts.input === undefined ? {} : { input: opts.input }),
            ...(opts.env === undefined ? {} : { env: opts.env }),
          });
          return args[0] === 'image' ? inspected : '';
        },
      );
      const answers = [...sandboxAnswers];
      const call = vi.fn((url: string, init?: RequestInit & { token?: string }) => {
        requests.push(`${init?.method ?? 'GET'} ${url.replace(/\?.*$/u, '')}`);
        const reply = (status: number, json: unknown = null, text = '') =>
          Promise.resolve({ status, json, text });
        if (url.includes('/v2/teams/')) return reply(200, { slug: 'acme' });
        if (url.includes('/v9/projects/')) return reply(projectStatus, { id: 'prj_1' });
        if (url.includes('/v11/projects')) return reply(200, { id: 'prj_new' });
        if (url.includes('/v4/sandboxes')) {
          const next = answers.shift() ?? { status: 201, text: '{}' };
          return reply(next.status, null, next.text);
        }
        return reply(200);
      });
      return { run, call, commands, requests };
    }

    it('pushes through an isolated docker config with the token on stdin only, then returns the registry digest reference', async () => {
      const f = fixture([
        { status: 400, text: '{"error":{"code":"image_not_ready"}}' },
        { status: 400, text: '{"error":{"code":"image_not_ready"}}' },
        { status: 201, text: '{}' },
      ]);
      const sleep = vi.fn(() => Promise.resolve());

      const image = await pushVercelSandboxImage({ ...options, run: f.run, call: f.call, sleep });

      expect(image).toBe(`acme/aw-lj-manager/agent-workspace-runtime@sha256:${PUSHED}`);
      expect(f.commands.map((command) => command.line)).toEqual([
        'docker login vcr.vercel.com --username team_x --password-stdin',
        `docker pull --platform linux/amd64 ${reference}`,
        `docker tag ${reference} ${tagged}`,
        `docker push ${tagged}`,
        `docker image inspect --format {{join .RepoDigests "\\n"}} ${tagged}`,
      ]);
      expect(f.commands.filter((command) => command.input !== undefined)).toEqual([
        expect.objectContaining({ input: TOKEN }),
      ]);
      expect(f.commands.map((command) => command.line).join('\n')).not.toContain(TOKEN);
      expect(f.commands.every((command) => command.env?.['DOCKER_CONFIG'] !== undefined)).toBe(
        true,
      );
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(f.requests.filter((request) => request.includes('/v4/sandboxes'))).toHaveLength(3);
      expect(f.requests.at(-1)).toMatch(/^DELETE .*\/v2\/sandboxes\/aw-ready-/u);
      expect(f.requests).not.toContainEqual(expect.stringContaining('/v11/projects'));
    });

    it('returns the VCR digest even when the source registry digest is listed first', async () => {
      const f = fixture([], 200, `${reference}\n${tagged.split(':')[0] ?? ''}@sha256:${PUSHED}\n`);
      const image = await pushVercelSandboxImage({ ...options, run: f.run, call: f.call });
      expect(image).toBe(`acme/aw-lj-manager/agent-workspace-runtime@sha256:${PUSHED}`);

      const sourceOnly = fixture([], 200, `${reference}\n`);
      await expect(
        pushVercelSandboxImage({ ...options, run: sourceOnly.run, call: sourceOnly.call }),
      ).rejects.toThrow(/has a registry digest/u);
    });

    it('creates the manager project when it does not exist', async () => {
      const f = fixture([], 404);
      await pushVercelSandboxImage({ ...options, run: f.run, call: f.call });
      expect(f.requests).toContain('POST https://api.vercel.com/v11/projects');
    });

    it('fails with the provider answer when the image never becomes ready, or is refused for another reason', async () => {
      const notReady = { status: 400, text: 'image_not_ready' };
      const waiting = fixture([notReady, notReady, notReady]);
      await expect(
        pushVercelSandboxImage({
          ...options,
          polls: 3,
          run: waiting.run,
          call: waiting.call,
          sleep: () => Promise.resolve(),
        }),
      ).rejects.toThrow(/does not start \(HTTP 400 image_not_ready\)/u);

      const refused = fixture([{ status: 403, text: '{"error":{"code":"forbidden"}}' }]);
      const sleep = vi.fn(() => Promise.resolve());
      await expect(
        pushVercelSandboxImage({ ...options, run: refused.run, call: refused.call, sleep }),
      ).rejects.toThrow(/HTTP 403/u);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('refuses an image that is not pinned by digest before any call', async () => {
      const f = fixture([]);
      await expect(
        pushVercelSandboxImage({ ...options, reference: 'agent-runtime:latest', ...f }),
      ).rejects.toThrow(/pinned by digest/u);
      expect(f.call).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    });
  });
});
