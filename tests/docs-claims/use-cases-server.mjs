/* global setTimeout, URL */
/** The processes and files a use-case project needs around `aw dev`: MCP servers and data folders. */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { JourneyFailure } from '../journey/harness.mjs';

/** @typedef {import('./use-cases-parse.mjs').ServerCommand} ServerCommand */

/** @param {string} dir a project directory @returns {string[]} the source of each `agents/*.ts` */
const agentSources = (dir) =>
  readdirSync(path.join(dir, 'agents'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(path.join(dir, 'agents', name), 'utf8'));

/** @param {string} text */
const quoted = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The commands that put a project's files where its agents expect them, as its project file and
 * its tutorial tell a user: for each `files('<folder>')` grant, `aw files mkdir <folder>`, then
 * `aw files upload` every file of `data/<folder>/` when the project ships one. Since #899 an upload
 * creates its folder, so the tutorials drop the mkdir for those; this harness keeps it because it
 * also runs against a published release that predates the fix, where a grant resolves against a
 * folder row only `mkdir` creates. The workspace is fresh, so the folder never exists yet.
 *
 * @param {string} dir a project directory
 * @returns {string[]}
 */
export function fileSetupCommands(dir) {
  const folders = new Set(
    agentSources(dir).flatMap((source) =>
      [...source.matchAll(/\bfiles\(\s*['"]([^'"]+)['"]/gu)].map((match) => match[1] ?? ''),
    ),
  );
  return [...folders].flatMap((folder) => {
    const data = path.join(dir, 'data', folder);
    const uploads = existsSync(data)
      ? readdirSync(data, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) =>
            path.relative(data, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'),
          )
          .sort()
          .map(
            (name) =>
              `aw files upload ${quoted(`${folder}/${name}`)} ${quoted(`data/${folder}/${name}`)}`,
          )
      : [];
    return [`aw files mkdir ${quoted(folder)}`, ...uploads];
  });
}

/**
 * The commands that publish the skill revisions a project's agents pin, as its tutorial tells a
 * user before `aw push`: for each `skill('<name>', { revision: 1 })`, `aw skills publish <name>
 * ./skills/<name>`. `aw dev` already imported the skill from `skills/<name>` on its first sync, and
 * a fresh workspace's first publish is revision 1; a pin on a revision that does not exist is
 * refused with `422 agent_definition_references_missing [skill:<name>@<revision>]`. A pin on a later
 * revision would need that many publishes, which no tutorial asks for, so it is refused here.
 *
 * @param {string} dir a project directory
 * @returns {string[]}
 */
export function skillPublishCommands(dir) {
  const pins = new Map(
    agentSources(dir).flatMap((source) =>
      [
        ...source.matchAll(/\bskill\(\s*['"]([^'"]+)['"]\s*,\s*\{\s*revision:\s*(\d+)\s*\}\s*\)/gu),
      ].map((match) => [match[1] ?? '', Number(match[2])]),
    ),
  );
  return [...pins].map(([name, revision]) => {
    if (revision !== 1) {
      throw new JourneyFailure(`${name} is pinned to revision ${String(revision)}, not 1`);
    }
    return `aw skills publish ${quoted(name)} ${quoted(`./skills/${name}`)}`;
  });
}

/**
 * Point the OpenAPI documents of a project (`apis/*.openapi.json`) at a stand-in API on loopback,
 * keeping each document's base path: their `servers` name the company's own host, which cannot be
 * resolved here, and a user trying the project edits the same line.
 *
 * @param {string} dir a project directory @param {number} port
 */
export function pointApisAtLoopback(dir, port) {
  const apis = path.join(dir, 'apis');
  if (!existsSync(apis)) return;
  for (const name of readdirSync(apis).filter((file) => file.endsWith('.openapi.json'))) {
    const file = path.join(apis, name);
    const document = JSON.parse(readFileSync(file, 'utf8'));
    const [server] = document.servers ?? [];
    const base = new URL(server?.url ?? 'http://api.invalid/').pathname.replace(/\/$/u, '');
    document.servers = [{ url: `http://127.0.0.1:${String(port)}${base}` }];
    writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  }
}

/**
 * Wait until something listens on `port` (`up`), or nothing does any more.
 *
 * @param {number} port @param {number} timeoutMs @param {boolean} [up]
 */
export async function listening(port, timeoutMs, up = true) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (open === up) return;
    if (Date.now() > until) {
      throw new JourneyFailure(
        up
          ? `nothing listens on port ${String(port)}`
          : `port ${String(port)} is still in use after the server was stopped`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Start one MCP server in its own process group, with no model key in its environment.
 *
 * @param {string} cwd @param {ServerCommand} server
 * @param {Record<string, string>} [env] in place of `server.env`
 */
export async function startServer(cwd, server, env = server.env) {
  const child = spawn(process.execPath, [server.script], {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: 'ignore',
  });
  const stop = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  };
  try {
    await listening(server.port, 30_000);
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
