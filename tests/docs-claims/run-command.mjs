/**
 * @typedef {import('./run.d.mts').Machine} Machine
 */
import path from 'node:path';
import { run } from '../generated-project/project.mjs';
import { exec, execOk, startDev } from '../journey/run.mjs';
import { CLAIMS_IN, COMPILE_IN, SHELL_SETUP, DEV_READY_MS, DEV_COMMAND } from './run-config.mjs';

/** @param {string} command */
export const shell = (command) => ['sh', '-c', `${SHELL_SETUP}${command}`];

/**
 * The journey's container as a {@link Machine}.
 *
 * @param {string} name @param {Record<string, string>} env @param {number} commandMs
 * @param {string} logs
 * @returns {Machine}
 */
export function containerMachine(name, env, commandMs, logs) {
  return {
    kind: 'container',
    shell: 'posix',
    fifo: true,
    env,
    commandMs,
    logs,
    claims: CLAIMS_IN,
    compile: COMPILE_IN,
    resolve: (cwd, to) => path.posix.resolve(cwd, to),
    mkdir: (dir) => execOk(name, ['mkdir', '-p', dir], { timeoutMs: 60_000, quiet: true }),
    project: (dir) => execOk(name, ['mkdir', '-p', dir], { timeoutMs: 60_000, quiet: true }),
    remove: (dir) => execOk(name, ['rm', '-rf', dir], { timeoutMs: 60_000, quiet: true }),
    list: async (dir) =>
      (await exec(name, shell('ls -A'), { workdir: dir, timeoutMs: 60_000, quiet: true })).stdout
        .split('\n')
        .filter((line) => line !== ''),
    stageCompile: async (stage) => {
      run('docker', ['cp', stage, `${name}:${COMPILE_IN}`], { timeoutMs: 120_000 });
      await execOk(name, ['chown', '-R', 'pwuser:pwuser', COMPILE_IN], {
        user: 'root',
        timeoutMs: 60_000,
        quiet: true,
      });
      return COMPILE_IN;
    },
    exec: (command, how) =>
      exec(name, shell(command), {
        workdir: how.cwd,
        env: { ...env, ...how.env },
        timeoutMs: how.timeoutMs,
        quiet: true,
      }),
    startDev: (cwd, extra) => startDev(name, cwd, { ...env, ...extra }),
  };
}

/**
 * One command of a block. `cd` moves the page's directory; `npm run dev` runs until ready and is
 * stopped; anything else is a shell command that must exit 0.
 *
 * @param {Machine} machine @param {{ cwd: string }} state @param {string} command
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function runCommand(machine, state, command) {
  const cd = /^cd (\S+)$/u.exec(command);
  if (cd?.[1] !== undefined) {
    state.cwd = machine.resolve(state.cwd, cd[1]);
    return { ok: true, output: `$ ${command}\n` };
  }
  if (command === DEV_COMMAND) {
    const dev = machine.startDev(state.cwd);
    try {
      await dev.untilWidget(DEV_READY_MS);
      await dev.stop((capMs) => capMs);
      return { ok: true, output: `$ ${command}\n${dev.state.log}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: `$ ${command}\n${dev.state.log}\n${message}\n` };
    } finally {
      // On the failure path `npm run dev` is still running and holds port 3000; killing only the
      // local side of a `docker exec` would leave it there for every later page, so the process
      // group is stopped first (the success path already did, setting `exit`).
      if (dev.state.exit === undefined) await dev.stop((capMs) => capMs).catch(() => undefined);
      dev.kill();
    }
  }
  const result = await machine.exec(command, { cwd: state.cwd, timeoutMs: machine.commandMs });
  return {
    ok: result.status === 0,
    output: `$ ${command}\n${result.output}\nexit ${String(result.status)}\n`,
  };
}
