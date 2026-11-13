import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { copyExample, lockArguments } from './app-image.mjs';
import { attempt, tail, stepOf } from './lane-commands.mjs';

/**
 * The app's image built with its own `npm run image`, pushed, and its digest reference; or the
 * reason it has none. The build context is a fresh copy of `examples/<id>`, locked against the
 * lane's loopback registry (`package-server.mjs`), so the `Dockerfile`'s `npm ci` installs this
 * checkout's packages at the versions the app pins; `--network host` lets the build reach it. The
 * copy and lock are `app-image.mjs`'s, which the live Cloud Run preview builds its app with too.
 *
 * @param {{ id: string, env: NodeJS.ProcessEnv, work: string, registry: ReturnType<typeof laneRegistry>, packages: { url: string } }} options
 */
export function appImage({ id, env, work, registry, packages }) {
  const context = path.join(work, 'images', id);
  copyExample(id, context);
  const locked = stepOf(
    'npm install --package-lock-only (the lane registry)',
    'npm',
    lockArguments(packages.url),
    { cwd: context, env },
  );
  if (locked.status !== 'ok') return { problem: locked.reason };
  const tag = `${registry.host()}/apps-lane-${id}:${randomBytes(3).toString('hex')}`;
  const built = attempt('npm', ['run', 'image', '--', '--network', 'host', '--tag', tag], {
    cwd: context,
    env,
    timeoutMs: 1_200_000,
  });
  if (built.status !== 0)
    return { problem: `npm run image exited ${String(built.status)}:\n${tail(built.output)}` };
  const pushed = attempt('docker', ['push', tag]);
  if (pushed.status !== 0) return { problem: `docker push failed:\n${tail(pushed.output)}` };
  const digest = attempt('docker', [
    'inspect',
    '--format',
    '{{index .RepoDigests 0}}',
    tag,
  ]).stdout.trim();
  return digest.includes('@sha256:') ? { image: digest } : { problem: `${tag} has no digest` };
}
