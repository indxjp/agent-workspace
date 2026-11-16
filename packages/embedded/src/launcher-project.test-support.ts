import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startMessage } from './launcher-api.test-support.js';
import { freePorts, type Ports } from './launcher-ports.test-support.js';
import { bin, ForkedRuntime, isAlive, readPostmasterPid } from './launcher-process.test-support.js';

interface RuntimeProjectOptions {
  readonly ports?: Ports;
  readonly detached?: boolean;
}

/** Owns the temporary project and every launcher child acquired by a lifecycle scenario. */
export class RuntimeTestProject {
  directory = '';
  ports: Ports = { web: 0, gateway: 0, runner: 0 };
  readonly runtimes: ForkedRuntime[] = [];
  private postmasterPid: number | undefined;

  constructor(private readonly prefix: string) {}

  async prepare(): Promise<void> {
    if (!existsSync(bin)) {
      throw new Error(`run pnpm --filter @indx-workspace/embedded build first; missing: ${bin}`);
    }
    this.directory = mkdtempSync(path.join(tmpdir(), this.prefix));
    this.ports = await freePorts();
  }

  get runtimeDirectory(): string {
    return path.join(this.directory, '.agent-workspace');
  }

  get secretsFile(): string {
    return path.join(this.runtimeDirectory, 'secrets', 'local-secrets.json');
  }

  fork(options: RuntimeProjectOptions = {}): ForkedRuntime {
    const runtime = new ForkedRuntime(this.directory, options.ports ?? this.ports, options);
    this.runtimes.push(runtime);
    return runtime;
  }

  async start(options: RuntimeProjectOptions = {}) {
    const runtime = this.fork(options);
    await runtime.send(startMessage(this.directory, options.ports ?? this.ports));
    const started = await runtime.started();
    await runtime.signInPrinted();
    return { runtime, ...started };
  }

  recordPostmaster(): number {
    const pid = readPostmasterPid(this.directory);
    this.postmasterPid = pid;
    return pid;
  }

  async close(): Promise<void> {
    await Promise.all(this.runtimes.map((runtime) => runtime.dispose()));
    const pid = this.postmasterPid;
    if (pid !== undefined && process.platform !== 'win32' && isAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
    if (this.directory !== '') {
      rmSync(this.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }
}
