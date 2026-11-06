/* global setTimeout, clearTimeout */
/**
 * `npm run dev` (or `aw dev`) as the journey runs it: started in the clean machine or any other
 * one, read line by line, waited on for its ready lines and stopped as Ctrl+C stops it.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

import { JourneyFailure, devOrigin, parseDevLine } from './harness.mjs';
import { PID_FILE_IN, exec, execOk, scrub } from './run-support.mjs';

/**
 * What `aw dev` prints when it gives up: its own `error:` line, or C6's warning that the `default`
 * model connection could not be created (the runtime keeps running, but no turn can finish).
 */
const REFUSAL_LINE = /^(?:error: |warning: could not set up the "default" model connection)/u;

/**
 * One `npm run dev` in the clean machine, read line by line.
 *
 * @param {string} machine @param {string} workdir @param {Readonly<Record<string, string>>} env
 */
export function startDev(machine, workdir, env) {
  const args = ['exec', '--workdir', workdir];
  for (const name of Object.keys(env)) args.push('--env', name);
  args.push(machine, 'sh', '-c', `echo $$ > ${PID_FILE_IN}; exec npm run dev`);
  const child = spawn('docker', args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return watchDev(child, {
    // Ctrl+C as a terminal sends it: SIGINT to the whole process group `npm run dev` leads (the
    // pid file's pid; `docker exec` starts it as a session and group leader). SIGINT to npm alone
    // stops nothing: npm forwards it to `sh -c aw dev`, and the shell neither exits nor passes it
    // on, so `aw` never hears it. A clean stop is aw's 0 or its interrupted 130.
    interrupt: async (limit) => {
      await execOk(machine, ['sh', '-c', `kill -s INT -- "-$(cat ${PID_FILE_IN})"`], {
        timeoutMs: limit(30_000),
      });
    },
    // What is still alive is the evidence a hung stop leaves: the process that ignored the
    // signal, or a grandchild still holding the exec's output open.
    survivors: async () =>
      (
        await exec(machine, ['ps', '-eo', 'pid,ppid,pgid,stat,etime,args', '--forest'], {
          timeoutMs: 30_000,
          quiet: true,
        })
      ).output,
    cleanExits: [0, 130],
  });
}

/** What a running `aw dev` has printed so far. */
function newDevState() {
  return {
    log: '',
    ready: /** @type {string | null} */ (null),
    signedIn: false,
    widget: /** @type {string | null} */ (null),
    modelConnection: false,
    /** How many `synced:` lines it printed. */
    syncs: 0,
    warning: /** @type {string | null} */ (null),
    /** The bootstrap admin's email, from the ready screen's console row. */
    adminEmail: /** @type {string | null} */ (null),
    /** The console's origin, from the ready screen's `console` row. */
    console: /** @type {string | null} */ (null),
    /** The app's origin, from the ready screen's `app` row (a project with an app). */
    app: /** @type {string | null} */ (null),
    exit: /** @type {number | null | undefined} */ (undefined),
  };
}

/** @typedef {ReturnType<typeof newDevState>} DevState */

/** Echo and log one piece of output, scrubbed. @param {DevState} state @param {string} text */
function echo(state, text) {
  state.log += text;
  process.stdout.write(scrub(text));
}

/** @param {DevState} state @param {ReturnType<typeof parseDevLine>} parsed */
function recordOrigins(state, parsed) {
  if (parsed?.kind === 'adminSignIn') state.adminEmail ??= parsed.email;
  else if (parsed?.kind === 'app') state.app ??= parsed.origin;
  else if (parsed?.kind === 'console') state.console ??= parsed.origin;
}

/** @param {DevState} state @param {ReturnType<typeof parseDevLine>} parsed @param {string} line */
function recordProgress(state, parsed, line) {
  const origin = devOrigin(parsed);
  if (origin !== null) state.ready ??= origin;
  if (parsed?.kind === 'signedIn') state.signedIn = true;
  else if (parsed?.kind === 'widget') state.widget ??= parsed.src;
  else if (parsed?.kind === 'modelConnection') state.modelConnection = true;
  else if (parsed?.kind === 'synced') state.syncs += 1;
  else if (REFUSAL_LINE.test(line.trim())) state.warning ??= line.trim();
}

/**
 * Until `predicate` holds for what `aw dev` printed, or a refusal, an exit or the timeout, each
 * failure naming the line `missing()` says is still missing.
 *
 * @param {DevState} state @param {(current: DevState) => boolean} predicate
 * @param {() => string} missing @param {number} timeoutMs
 */
async function waitForDev(state, predicate, missing, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.warning !== null) throw new JourneyFailure(`aw dev: ${scrub(state.warning)}`);
    if (state.exit !== undefined) {
      throw new JourneyFailure(
        `npm run dev exited ${String(state.exit)} before the ${missing()} line`,
      );
    }
    if (predicate(state)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new JourneyFailure(
    `npm run dev printed no ${missing()} line within ${String(Math.round(timeoutMs / 1000))} s`,
  );
}

/**
 * Until the process has exited, or `waitMs` has run out.
 *
 * @param {Promise<number | null>} exited @param {number} waitMs
 * @returns {Promise<number | null | 'timeout'>}
 */
async function exitOrTimeout(exited, waitMs) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), waitMs);
  });
  const code = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  return /** @type {number | null | 'timeout'} */ (code);
}

/**
 * Ctrl+C, then a wait for a clean exit.
 *
 * @param {Parameters<typeof watchDev>[1]} how @param {Promise<number | null>} exited
 * @param {() => NodeJS.Signals | null} exitSignal the signal that ended it, once it has
 * @param {(capMs: number) => number} limit
 */
async function stopDev(how, exited, exitSignal, limit) {
  await how.interrupt(limit);
  const waitMs = limit(90_000);
  const code = await exitOrTimeout(exited, waitMs);
  if (code === 'timeout') {
    throw new JourneyFailure(
      `npm run dev did not stop within ${String(Math.round(waitMs / 1000))} s of SIGINT; still running:\n${scrub(await how.survivors())}`,
    );
  }
  const signal = exitSignal();
  const diedOfSigint = code === null && signal === 'SIGINT';
  if (how.cleanExits !== null && !diedOfSigint && !how.cleanExits.includes(code)) {
    throw new JourneyFailure(
      `npm run dev exited ${String(code)} (signal ${signal ?? 'none'}) on SIGINT, not cleanly`,
    );
  }
}

/**
 * A running `aw dev` (any machine) read line by line: what it printed, whether it is ready and
 * signed in, and how to stop it.
 *
 * @param {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>} child
 * @param {{ interrupt: (limit: (capMs: number) => number) => Promise<void>,
 *   survivors: () => Promise<string>, cleanExits: readonly (number | null)[] | null }} how
 *   `interrupt` sends Ctrl+C to what `child` started; `cleanExits` are the exit codes of a clean
 *   stop (or a death by the SIGINT itself), or null when the machine can only kill (Windows has
 *   no SIGINT for a process tree)
 */
export function watchDev(child, how) {
  const state = newDevState();
  let pending = '';
  /**
   * Whole lines only, each parsed before it is echoed.
   *
   * @param {Buffer} chunk
   */
  const read = (chunk) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseDevLine(line);
      recordOrigins(state, parsed);
      echo(state, `${line}\n`);
      recordProgress(state, parsed, line);
    }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  /** The signal that ended it, if one did (macOS reports our SIGINT this way, with no code). */
  let signal = /** @type {NodeJS.Signals | null} */ (null);
  /** @type {Promise<number | null>} */
  const exited = new Promise((resolve) => {
    child.once('close', (code, closeSignal) => {
      signal = closeSignal;
      if (pending !== '') echo(state, pending);
      pending = '';
      state.exit = code;
      resolve(code);
    });
  });
  /** @param {(current: DevState) => boolean} predicate @param {() => string} missing @param {number} timeoutMs */
  const until = (predicate, missing, timeoutMs) => waitForDev(state, predicate, missing, timeoutMs);

  return {
    state,
    exited,
    until,
    /** Until `ready`, `signed in` and the `widget:` line, or a refusal. @param {number} timeoutMs */
    async untilWidget(timeoutMs) {
      await until(
        (current) => current.ready !== null && current.signedIn && current.widget !== null,
        () => (state.ready === null ? 'ready' : state.signedIn ? 'widget:' : 'signed in'),
        timeoutMs,
      );
      if (state.ready === null || state.widget === null) {
        throw new JourneyFailure('npm run dev reported no ready or widget: line');
      }
      return { ready: state.ready, widget: state.widget };
    },
    /** @param {(capMs: number) => number} limit */
    stop: (limit) => stopDev(how, exited, () => signal, limit),
    kill() {
      if (state.exit === undefined) child.kill('SIGKILL');
    },
  };
}
