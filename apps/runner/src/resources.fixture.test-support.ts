import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RunRequest,
  type RunFileReference,
  type RunFileResource,
  type RunSkillReference,
} from '@agent-workspace/run-protocol';
import { skillsUnderConfigDirectory, type EngineSkillGrant } from '@agent-workspace/engine';
import { toEngineRunRequest } from './engines.js';
import {
  materializeRunResources,
  type ResolvedRunRequest,
  type SkillPlacingEngine,
} from './resources.js';

export /**
 * The engine, as materialisation sees one (ENG-04b, #325).
 *
 * A stand-in for the Claude adapter rather than the adapter itself: what this file is about is the
 * *writing*, and the two answers it needs from an engine are a directory name and a list of paths.
 * Taking them from a fixture is what lets the escape cases below exist at all — the real adapter
 * cannot be asked to place a skill outside its own directory.
 */
const ENGINE: SkillPlacingEngine = {
  protectedConfigDirectory: '.claude',
  placeSkills: (engineRequest) =>
    skillsUnderConfigDirectory(engineRequest.resources.skills, '.claude'),
};

export function wireRequest(
  root: string,
  files: readonly RunFileResource[],
  skills: readonly RunSkillReference[] = [],
) {
  const cwd = path.join(root, 'workspace');
  return RunRequest.parse({
    runId: '11111111-1111-4111-8111-111111111111',
    sessionId: '44444444-4444-4444-8444-444444444444',
    cwd,
    prompt: 'test',
    projectKey: 'workspace',
    portable: {
      name: 'test',
      instructions: '',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: { tools: null, fileGrantDeny: [] },
    session: { kind: 'fresh', sessionId: '44444444-4444-4444-8444-444444444444' },
    env: {},
    resources: { files, skills },
  });
}

export /** A request whose skills carry their bytes, the shape the runner hands to the engine port. */
function request(
  root: string,
  files: readonly RunFileResource[],
  skills: readonly EngineSkillGrant[] = [],
): ResolvedRunRequest {
  return { ...wireRequest(root, files), resources: { files, skills } };
}

export /**
 * A file grant the way a run names it: by reference. The bytes are laid down separately, as
 * `POST /files` does (see {@link layFile}); materialization checks the path and sets the mode.
 */
function fileRef(name: string, access: 'read' | 'read-write', size = 0): RunFileReference {
  return { kind: 'file', path: name, access, size, sha256: '0'.repeat(64) };
}

export /** Write `body` at `name` inside the request's workspace, as `POST /files` would. */
async function layFile(parsed: ResolvedRunRequest, name: string, body: string): Promise<void> {
  const target = path.join(parsed.cwd, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}

export /** Materialize one request through {@link ENGINE}, the way `index.ts` does through the real one. */
function materialize(parsed: ResolvedRunRequest, engine: SkillPlacingEngine = ENGINE) {
  return materializeRunResources(parsed, toEngineRunRequest(parsed), engine);
}

export /** Where {@link ENGINE} keeps its configuration, for a test that asserts about a written path. */
function configDirOf(parsed: { readonly cwd: string }): string {
  return path.join(parsed.cwd, ENGINE.protectedConfigDirectory);
}

/**
 * Restore write permission across a scratch root before removing it.
 *
 * Materialization deliberately leaves a granted tree as `0o555` directories and `0o444` files, and
 * POSIX needs write permission on the *containing* directory to unlink anything inside it. A plain
 * `rm` of the root therefore fails with `EACCES` on the first entry the last turn locked down, so
 * these tests restore the modes before removing the temporary directory.
 */
async function restoreWritable(target: string): Promise<void> {
  const stats = await lstat(target).catch(() => null);
  if (stats === null || stats.isSymbolicLink()) return;
  await chmod(target, stats.isDirectory() ? 0o700 : 0o600);
  if (!stats.isDirectory()) return;
  for (const entry of await readdir(target)) await restoreWritable(path.join(target, entry));
}

async function removeRoot(root: string): Promise<void> {
  await restoreWritable(root);
  await rm(root, { recursive: true, force: true });
}

export async function withResourceRoot(
  prefix: string,
  run: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await run(root);
  } finally {
    await removeRoot(root);
  }
}
