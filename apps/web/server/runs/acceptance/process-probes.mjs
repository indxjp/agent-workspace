/* global process, setTimeout */
import { spawn } from 'node:child_process';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createProcessSupervisor() {
  const children = [];
  function start(command, argv, options) {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    children.push(child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const tag = options?.tag ?? command;
    child.stdout.on('data', (d) => process.stdout.write(`  [${tag}] ${d}`));
    child.stderr.on('data', (d) => process.stdout.write(`  [${tag}!] ${d}`));
    return child;
  }

  function killTree(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }

  function run(command, argv, options) {
    return new Promise((resolvePromise, reject) => {
      const child = start(command, argv, options);
      child.on('exit', (code) =>
        code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${String(code)}`)),
      );
    });
  }

  return {
    start,
    run,
    stop: () => {
      for (const child of children) killTree(child);
    },
  };
}

export async function waitFor(description, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      if (await probe()) return;
      lastError = 'the probe returned false';
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
    if (Date.now() > deadline) {
      // Say WHY. A bare "timed out" turns a diagnosable failure into a guess, and this script
      // spent two ten-minute runs proving that.
      throw new Error(
        `timed out waiting for ${description}: ${lastError ?? 'the probe never reported why'}`,
      );
    }
    await sleep(500);
  }
}

/** Run a command and return its exit code and combined output. */
export function captureExit(command, argv) {
  return new Promise((resolvePromise) => {
    let out = '';
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolvePromise({ code, out: out.trim() }));
    child.on('error', (cause) => resolvePromise({ code: -1, out: cause.message }));
  });
}

/** The same, when only the output matters. */
export async function capture(command, argv) {
  return (await captureExit(command, argv)).out;
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Choose the `--add-host aw-host:<value>` a bridge-network container can actually reach this host
 * on, by TRYING each candidate from inside a throwaway container of the same image.
 *
 * Neither candidate is reliable on its own, and both failed here at least once:
 *
 *   * `host-gateway` is the documented spelling. On this Docker Desktop host it resolves to an
 *     IPv6 address, and R-13 records a probe that produced a false positive from exactly that
 *     ("host.docker.internal resolving to an unreachable IPv6 address").
 *   * the bridge network's own IPv4 gateway is the obvious fix for that, and on this host nginx
 *     answered 502 through it - the Docker VM's bridge gateway is not the Windows host.
 *
 * So the address is neither guessed nor defaulted: the probe proceeds because a candidate
 * POSITIVELY fetched a page from the upstream, or it stops and reports that every candidate failed.
 */
export async function pickHostAlias(webPort) {
  const bridge = await capture('docker', [
    'network',
    'inspect',
    'bridge',
    '-f',
    '{{range .IPAM.Config}}{{.Gateway}} {{end}}',
  ]);
  const candidates = ['host-gateway', ...bridge.split(/\s+/).filter((t) => IPV4.test(t))];
  const tried = [];
  for (const candidate of candidates) {
    const probe = await captureExit('docker', [
      'run',
      '--rm',
      '--add-host',
      `aw-host:${candidate}`,
      '--entrypoint',
      'wget',
      'nginx:1.29-alpine',
      '-q',
      '-T',
      '4',
      '-O',
      '/dev/null',
      `http://aw-host:${String(webPort)}/`,
    ]);
    if (probe.code === 0) return candidate;
    tried.push(`${candidate} (exit ${String(probe.code)}${probe.out ? `: ${probe.out}` : ''})`);
  }
  throw new Error(
    `no container-to-host address worked for port ${String(webPort)}. Tried: ${tried.join('; ')}`,
  );
}
