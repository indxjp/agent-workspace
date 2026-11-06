import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { check, spawnChecked } from '../build-deploy-journey/journey.e2e.mjs';
import { call } from './journey-http.mjs';

export const VERCEL = 'https://api.vercel.com';

export const VCR = 'vcr.vercel.com';

export const VCR_REPOSITORY = 'agent-workspace-runtime';

/**
 * The runtime image the `vercel-sandbox` manager runs, in the manager project's Vercel Container
 * Registry (ADR-0120 LC2): Vercel Sandbox runs no image from any other registry. Looks up the team
 * slug, creates the `<project>-manager` project when absent, logs in with the token on stdin and an
 * isolated `DOCKER_CONFIG`, pulls the image for linux/amd64, tags it, pushes it, reads the registry
 * digest, then creates (and deletes) a throwaway sandbox until the registry has finished with the
 * image (`image_not_ready` is the answer until then). Returns `<slug>/<project>-manager/<repo>@sha256:<d>`.
 *
 * @param {{
 *   reference: string, team: string, token: string, project: string,
 *   run?: typeof spawnChecked, call?: typeof call, sleep?: (ms: number) => Promise<unknown>,
 *   polls?: number, pollMs?: number,
 * }} options
 */
export async function pushVercelSandboxImage({
  reference,
  team,
  token,
  project,
  run = spawnChecked,
  call: api = call,
  sleep = delay,
  polls = 30,
  pollMs = 10_000,
}) {
  const digest = /@sha256:([0-9a-f]{64})$/u.exec(reference)?.[1];
  check(digest !== undefined, 'the runtime image is pinned by digest');
  const query = `teamId=${encodeURIComponent(team)}`;
  const json = { 'content-type': 'application/json' };
  const slug = (await api(`${VERCEL}/v2/teams/${encodeURIComponent(team)}`, { token })).json?.slug;
  check(typeof slug === 'string', 'the Vercel team has a slug');
  const manager = `${project}-manager`;
  let found = await api(`${VERCEL}/v9/projects/${encodeURIComponent(manager)}?${query}`, { token });
  if (found.status !== 200) {
    found = await api(`${VERCEL}/v11/projects?${query}`, {
      method: 'POST',
      token,
      headers: json,
      body: JSON.stringify({ name: manager }),
    });
  }
  const projectId = found.json?.id;
  check(
    typeof projectId === 'string',
    `the ${manager} project exists (HTTP ${String(found.status)})`,
  );

  const repository = `${VCR}/${slug}/${manager}/${VCR_REPOSITORY}`;
  const tagged = `${repository}:sha256-${digest}`;
  const dockerConfig = mkdtempSync(path.join(tmpdir(), 'aw-vcr-'));
  const env = { ...process.env, DOCKER_CONFIG: dockerConfig };
  try {
    run('docker', ['login', VCR, '--username', team, '--password-stdin'], { env, input: token });
    run('docker', ['pull', '--platform', 'linux/amd64', reference], { env });
    run('docker', ['tag', reference, tagged], { env });
    run('docker', ['push', tagged], { env, timeout: 900_000 });
    const pushed = run(
      'docker',
      ['image', 'inspect', '--format', '{{join .RepoDigests "\\n"}}', tagged],
      { env },
    )
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith(`${repository}@sha256:`))
      ?.slice(repository.length + 1);
    check(pushed !== undefined, 'the pushed runtime image has a registry digest');
    const image = `${slug}/${manager}/${VCR_REPOSITORY}@${String(pushed)}`;

    const sandbox = `aw-ready-${randomBytes(6).toString('hex')}`;
    for (let attempt = 1; ; attempt += 1) {
      const created = await api(`${VERCEL}/v4/sandboxes?${query}`, {
        method: 'POST',
        token,
        headers: json,
        body: JSON.stringify({
          name: sandbox,
          projectId,
          image,
          persistent: false,
          timeout: 60_000,
        }),
      });
      if (created.status >= 200 && created.status < 300) {
        await api(
          `${VERCEL}/v2/sandboxes/${sandbox}?${query}&projectId=${encodeURIComponent(projectId)}`,
          { method: 'DELETE', token },
        );
        return image;
      }
      check(
        created.text.includes('image_not_ready') && attempt < polls,
        `the pushed runtime image does not start (HTTP ${String(created.status)} ${created.text.slice(0, 200)})`,
      );
      await sleep(pollMs);
    }
  } finally {
    rmSync(dockerConfig, { recursive: true, force: true });
  }
}

/**
 * The last error-looking lines of a Vercel deployment's runtime log, for the failure message of a
 * control plane that never answered `/setup`: a start-up refusal is logged by apps/web and shows
 * as a bare HTTP 500 otherwise. `vercel logs` streams, so it is killed after `timeoutMs` and what
 * arrived is kept. Best effort: any failure is a placeholder, never an error. The token is in the
 * child's environment only; the caller redacts the result with the run's secrets.
 *
 * @param {{
 *   url: string, team: string, token: string, lines?: number, timeoutMs?: number,
 *   run?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv, timeout: number }) => { stdout?: string | null, error?: Error },
 * }} options
 */
export function vercelLogExcerpt({
  url,
  team,
  token,
  lines = 5,
  timeoutMs = 60_000,
  run = (command, args, options) =>
    spawnSync(command, args, { ...options, encoding: 'utf8', maxBuffer: 1 << 20 }),
}) {
  const result = run('vercel', ['logs', url, '--scope', team], {
    env: { ...process.env, VERCEL_TOKEN: token },
    timeout: timeoutMs,
  });
  // A timeout is the expected end of a stream: `error` is set, `stdout` holds what arrived.
  const matched = (result.stdout ?? '')
    .split(/\r?\n/u)
    .filter((line) => /error|invalid|throw|refus|fail/iu.test(line))
    .slice(-lines)
    .join(' | ')
    .slice(0, 1_000);
  if (matched !== '') return matched;
  return `(no runtime log excerpt: ${result.error === undefined ? 'no error lines' : result.error.message.slice(0, 120)})`;
}

/**
 * `error` extended with the Vercel runtime-log excerpt of each deployment in `targets`
 * (`[label, url]` pairs), the cause chain kept. The caller redacts the message with the run's secrets.
 *
 * @param {unknown} error
 * @param {{ targets: [string, string][], team: string, token: string, run?: Parameters<typeof vercelLogExcerpt>[0]['run'] }} options
 */
export function withVercelLogs(error, { targets, team, token, run }) {
  const logs = targets.map(
    ([label, url]) =>
      `${label} log: ${vercelLogExcerpt({ url, team, token, ...(run === undefined ? {} : { run }) })}`,
  );
  return new Error(
    `${error instanceof Error ? error.message : String(error)} — ${logs.join(' — ')}`,
    {
      cause: error,
    },
  );
}
