import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const driverLine = z.looseObject({ event: z.string() });
type DriverLine = z.infer<typeof driverLine>;

export function driverSource(runnerDist: string): string {
  const url = (file: string): string =>
    JSON.stringify(pathToFileURL(path.join(runnerDist, file)).href);
  return [
    `import { readFileSync } from 'node:fs';`,
    `import { runnerBaseEnvironment, sessionMirrorDeps, startAgentInThisContainer } from ${url('index.js')};`,
    ``,
    `const say = (line) => { process.stdout.write(JSON.stringify(line) + '\\n'); };`,
    `const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));`,
    ``,
    `const request = { ...plan.request, env: { AW_SESSION_MIRROR_TOKEN: process.env.AW_SESSION_MIRROR_TOKEN } };`,
    `const context = sessionMirrorDeps(process.env, request.env.AW_SESSION_MIRROR_TOKEN, request.engine);`,
    `const outcome = await startAgentInThisContainer(request, runnerBaseEnvironment(), context);`,
    `if (!outcome.ok) { say({ event: 'fatal', reason: outcome.code + ': ' + outcome.reason }); process.exit(3); }`,
    `const connection = outcome.connection;`,
    `let text = '';`,
    `try {`,
    `  for await (const frame of connection.frames) {`,
    `    if (frame.frame === 'agent.session') say({ event: 'init', sessionId: frame.engineSessionId });`,
    `    if (frame.frame === 'agent.message' && frame.role === 'assistant') {`,
    `      for (const block of frame.blocks) if (block.type === 'text') text += block.text;`,
    `    }`,
    `    if (frame.frame === 'agent.result') say({ event: 'result', stopReason: frame.stopReason });`,
    `  }`,
    `} catch (error) {`,
    `  say({ event: 'threw', message: error instanceof Error ? error.message : String(error) });`,
    `}`,
    `say({ event: 'text', text });`,
    `say({ event: 'durability', verdict: connection.sessionDurability() });`,
    `say({ event: 'done', pid: process.pid });`,
    `if (plan.holdOpen) { setInterval(() => {}, 1000); } else { process.exit(0); }`,
    ``,
  ].join('\n');
}

export interface ChildOutcome {
  readonly lines: DriverLine[];
  readonly stderr: string;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Spawn one driver and stream its JSON lines. */
export function spawnDriver({
  driver,
  planFile,
  mirrorUrl,
  runToken,
}: {
  readonly driver: string;
  readonly planFile: string;
  readonly mirrorUrl: string;
  readonly runToken: string;
}): ChildOutcome {
  const child = spawn(process.execPath, [driver, planFile], {
    env: {
      ...process.env,
      AW_SESSION_MIRROR_URL: mirrorUrl,
      AW_SESSION_MIRROR_TOKEN: runToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines: DriverLine[] = [];
  let pending = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    for (;;) {
      const at = pending.indexOf('\n');
      if (at < 0) break;
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.trim().length === 0) continue;
      try {
        lines.push(driverLine.parse(JSON.parse(line)));
      } catch {
        stderr += `[unparsed stdout] ${line}\n`;
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  return {
    lines,
    get stderr(): string {
      return stderr;
    },
    child,
    exited,
  };
}

/** Wait until the driver has printed an event of this name, or fail with everything it said. */
export async function waitFor(
  outcome: ChildOutcome,
  event: string,
  timeoutMs: number,
): Promise<DriverLine> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = outcome.lines.find((line) => line.event === event);
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `the driver never printed a '${event}' line within ${String(timeoutMs)}ms.\n` +
          `lines: ${JSON.stringify(outcome.lines, null, 2)}\nstderr: ${outcome.stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Kill the child's whole process tree, for real. */
export function killTree(child: ChildProcessByStdio<null, Readable, Readable>): void {
  const pid = child.pid;
  if (pid === undefined) throw new Error('the child has no pid, so nothing can be killed');
  if (process.platform === 'win32') {
    // `child.kill('SIGKILL')` maps to TerminateProcess on this process alone, which would leave
    // the SDK's own `claude` subprocess alive and writing. /T is the tree, /F is unconditional.
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  process.kill(-pid, 'SIGKILL');
}
