import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_LOCAL_PORT,
  type ProjectDocument,
  type ProjectRead,
} from '@indx-workspace/contracts/project-file';
import { parseProjectFile, PROJECT_FILE_NAME, ProjectFileError } from '@indx-workspace/sdk/project';
import { z } from 'zod';

import { UsageError } from '../io.js';

/** The `code` of a Node.js system error (`ENOENT`, `EEXIST`, …), or `undefined` for anything else. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * The URL the local runtime serves a project on, and the key its credential is stored under. One
 * builder, shared by `aw dev` and the configuration's project step, so the credential `aw dev`
 * stores is the one `aw me` then finds.
 */
export function localProjectUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

/** The `ProjectFileError` message's own `agent-workspace.yaml line L, column C: ` prefix. */
const POSITION_PREFIX = /^agent-workspace\.yaml line \d+, column \d+: /u;

/**
 * Read `<cwd>/agent-workspace.yaml`: the project as written (or a lifted v1 profile), or `null`
 * when there is no such file. A file that cannot be read, or that the project schema refuses, is a
 * usage error naming `agent-workspace.yaml:<line>:<column>` — never silently skipped.
 */
export async function readLocalProject(cwd: string): Promise<ProjectRead | null> {
  let text: string;
  try {
    text = await readFile(path.join(cwd, PROJECT_FILE_NAME), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new UsageError(`could not read ${PROJECT_FILE_NAME}`);
  }
  try {
    return parseProjectFile(text);
  } catch (error) {
    if (error instanceof ProjectFileError) {
      const detail = error.message.replace(POSITION_PREFIX, '');
      throw new UsageError(
        `${PROJECT_FILE_NAME}:${String(error.line)}:${String(error.column)}: ${detail}`,
      );
    }
    throw error;
  }
}

/** The port a v2 project's local environment is served on. */
export function localPortOf(read: Extract<ProjectRead, { readonly lifted: false }>): number {
  return read.project.environments.local.port ?? DEFAULT_LOCAL_PORT;
}

/**
 * The control plane URL a project names for the configuration's project step: the local
 * environment's for a v2 file, nothing for a lifted v1 profile (which names no port and may not
 * describe a local environment at all).
 */
export function projectUrlOf(read: ProjectRead): string | undefined {
  return read.lifted ? undefined : localProjectUrl(localPortOf(read));
}

/**
 * Issue #730: `<project>/.aw/runtime.json`, the port a running `aw dev` bound and its own pid. `aw
 * dev` writes it once the runtime is ready and removes it when it returns, so the project step
 * reaches a runtime that moved off a busy port. Only the port is kept, never a URL: whatever the
 * file says, the project step can only name `http://127.0.0.1:<port>`, as the project file can.
 */
const RuntimeRecordSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    pid: z.number().int().positive(),
  })
  .strict();

function runtimeRecordPath(cwd: string): string {
  return path.join(cwd, '.aw', 'runtime.json');
}

/** Record that this process serves the project in `cwd` on `port` (issue #730). */
export async function writeRuntimeRecord(cwd: string, port: number): Promise<void> {
  const filePath = runtimeRecordPath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ port, pid: process.pid })}\n`);
}

/** Remove the record {@link writeRuntimeRecord} wrote; nothing to remove is fine. */
export async function removeRuntimeRecord(cwd: string): Promise<void> {
  await rm(runtimeRecordPath(cwd), { force: true });
}

/** Whether a process with `pid` exists: signal 0 checks without sending anything. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return errorCode(error) === 'EPERM';
  }
}

/**
 * The port and pid of a running `aw dev` for the project in `cwd`, or `undefined` when there is no
 * record, it is unreadable, or the `aw dev` that wrote it is gone (killed before it could remove
 * it). The record is written only once the runtime is ready and signed in.
 *
 * ponytail: a pid reused by an unrelated process keeps a stale record alive; the recorded port then
 * answers nothing and the command fails as it would against a stopped runtime.
 */
export async function runningRuntime(
  cwd: string,
): Promise<{ readonly port: number; readonly pid: number } | undefined> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(runtimeRecordPath(cwd), 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = RuntimeRecordSchema.safeParse(json);
  if (!parsed.success || !processAlive(parsed.data.pid)) return undefined;
  return parsed.data;
}

/** The URL of {@link runningRuntime}; the caller falls back to the project file's URL. */
export async function runningRuntimeUrl(cwd: string): Promise<string | undefined> {
  const running = await runningRuntime(cwd);
  return running === undefined ? undefined : localProjectUrl(running.port);
}

/** The variable the C6 `default` connection is made from when the project declares no `models`. */
export const DEFAULT_MODEL_SECRET = 'ANTHROPIC_API_KEY';

/** The secret model connection `connectionName` is made from (issue #661): its
 * `credential.secret`, or {@link DEFAULT_MODEL_SECRET} for the C6 `default` connection. */
export function modelSecretOf(project: ProjectDocument, connectionName: string): string {
  return project.models?.[connectionName]?.credential.secret ?? DEFAULT_MODEL_SECRET;
}

/** The secrets the model connections the project runs on are made from, each once, sorted; a
 * lifted v1 profile declares no `models`, so it runs on the C6 `default` connection too. */
export function modelSecretNames(read: ProjectRead): readonly string[] {
  const models = read.lifted ? undefined : read.project.models;
  if (models === undefined) return [DEFAULT_MODEL_SECRET];
  return [...new Set(Object.values(models).map((model) => model.credential.secret))].sort();
}

/**
 * The secret names the project file references — `models.*.credential` and
 * `connectors.*.auth.credential` — each once, sorted; none for a lifted v1 profile (SD17).
 */
export function projectSecretNames(read: ProjectRead): readonly string[] {
  if (read.lifted) return [];
  const { models = {}, connectors = {} } = read.project;
  const names = [
    ...Object.values(models).map((model) => model.credential.secret),
    ...Object.values(connectors).flatMap((connector) =>
      connector.auth === undefined ? [] : [connector.auth.credential.secret],
    ),
  ];
  return [...new Set(names)].sort();
}
