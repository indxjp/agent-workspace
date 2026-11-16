import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { LocalRuntimeStartMessageSchema } from '@indx-workspace/contracts/local-runtime';
import { describe, expect, it } from 'vitest';

import { localCredentialsFilePath } from '../local-runtime/local-credentials.js';
import { EXIT_CODE } from '../output.js';
import {
  READY,
  CREDENTIAL,
  sends,
  fakeRuntime,
  freshDirectory,
  renderedYaml,
  project,
  dev,
  signedIn,
} from './dev.test-support.js';
import { modelConnections } from './dev.routes.test-support.js';

describe('aw dev (issue #451): accepts loopback and refuses bad admins', () => {
  it.each(['http://localhost:3000', 'http://[::1]:3000'])(
    'accepts a ready on %s, a loopback host the contract allows, on the asked port',
    async (url) => {
      const cwd = await project({ script: fakeRuntime(sends({ ...READY, url }, CREDENTIAL)) });
      const { run } = await dev(cwd, { until: signedIn });
      expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
      expect(run.stdout).toContain('Agent Workspace');
    },
  );

  it('prints the address the runtime signs in as: lowercased, or BOOTSTRAP_ADMIN', async () => {
    const yaml = renderedYaml().replace('admin@localhost.test', 'Admin@Localhost.TEST');
    expect(yaml).toContain('Admin@Localhost.TEST');
    const cwd = await project({ yaml, script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const mixed = await dev(cwd, { route: modelConnections([]), until: signedIn });
    expect(mixed.run.stdout).toContain('signed in as admin@localhost.test (workspace local)\n');
    const overridden = await dev(cwd, {
      env: { BOOTSTRAP_ADMIN: 'Owner@Example.COM' },
      route: modelConnections([]),
      until: signedIn,
    });
    expect(overridden.run.stdout).toContain('signed in as owner@example.com (workspace local)\n');
  });

  it('refuses a project file whose bootstrap admin holds a terminal control character, echoing nothing', async () => {
    const yaml = renderedYaml().replace(
      'admin@localhost.test',
      '"evil\\u001b]0;pwned\\u0007\\u001b[2J@x.test"',
    );
    const cwd = await project({ yaml, script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, { route: modelConnections([]), until: signedIn });
    // The contract's schema refuses it while the project file is read, by line and column.
    expect(run.code, run.stderr).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain(
      'environments.local.identity.bootstrapAdmin must not contain a control character',
    );
    expect(run.stdout + run.stderr).not.toContain('\u001b');
    expect(run.stdout + run.stderr).not.toContain('pwned');
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });
});

describe('aw dev (issue #451): moves a busy web port', () => {
  it('moves an unpinned web port that is busy to the next free one and says so', async () => {
    // Hold 3000 if nothing does yet; either way it is busy for the whole case.
    const holder = createServer();
    await new Promise<void>((resolve) => {
      holder.once('error', () => {
        resolve();
      });
      holder.listen(3000, '127.0.0.1', resolve);
    });
    try {
      const ready = { ...READY, url: 'http://127.0.0.1:PORT' };
      const script = fakeRuntime(
        `await send({ ...${JSON.stringify(ready)}, url: 'http://127.0.0.1:' + start.environment.port });
${sends(CREDENTIAL)}`,
      );
      const cwd = await project({ script });
      // Issue #730: while it runs, the record other `aw` commands read names the port it bound.
      const recordFile = path.join(cwd, '.aw', 'runtime.json');
      let record: unknown;
      const { run, home } = await dev(cwd, {
        env: { AW_DATABASE_PORT: undefined },
        until: (output) => {
          if (!signedIn(output)) return false;
          // Read once: later output (the interruption) arrives after the clean exit removed it.
          record ??= JSON.parse(readFileSync(recordFile, 'utf8'));
          return true;
        },
      });
      const start = LocalRuntimeStartMessageSchema.parse(
        JSON.parse(await readFile(path.join(cwd, 'start.json'), 'utf8')),
      );
      expect(start.environment.port).toBeGreaterThan(3000);
      expect(run.stdout).toContain(
        `web       on :${String(start.environment.port)} (3000 was busy)`,
      );
      expect(record).toEqual({ port: start.environment.port, pid: process.pid });
      // The record is written on sign-in, after the key for that port was stored.
      const stored: unknown = JSON.parse(await readFile(localCredentialsFilePath(home), 'utf8'));
      expect(stored).toHaveProperty([`http://127.0.0.1:${String(start.environment.port)}`]);
      // A clean exit removes it, so the project file's port is used again.
      expect(existsSync(recordFile)).toBe(false);
    } finally {
      holder.close();
    }
  });
});

describe('aw dev (issue #451): refuses a bad environment or a missing project', () => {
  it.each([
    ['a terminal control sequence', 'evil\u001b]0;pwned\u0007\u001b[2J@x.test'],
    ['a C1 control', 'evil\u009bpwned@x.test'],
    ['a value that is not an email address', 'pwned'],
  ])('refuses a BOOTSTRAP_ADMIN override holding %s, echoing nothing', async (_case, override) => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, {
      env: { BOOTSTRAP_ADMIN: override },
      route: modelConnections([]),
      until: signedIn,
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe(
      'error: the bootstrap admin address is not a plain email address (it may hold a control character), so aw dev will not print or use it\n' +
        'fix: set identity.bootstrapAdmin in agent-workspace.yaml (or BOOTSTRAP_ADMIN) to a plain email address\n',
    );
    expect(run.stdout + run.stderr).not.toContain('\u001b');
    expect(run.stdout + run.stderr).not.toContain('\u009b');
    expect(run.stdout + run.stderr).not.toContain('pwned');
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });

  it('refuses outside a project, naming aw init', async () => {
    const cwd = await freshDirectory();
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe(
      'error: no agent-workspace.yaml in this directory\nfix: aw init --yes\n',
    );
  });
});

describe('aw dev (issue #451): refuses a bad project file', () => {
  it.each([
    [
      'a lifted v1 profile with storage',
      [
        'apiVersion: agentworkspace.dev/v1',
        'kind: Deployment',
        'cloud: local',
        'storage:',
        '  relational: compose',
        '  objects: compose',
        '  secrets: compose',
        'runtime:',
        '  default: docker',
        'identity:',
        '  bootstrapAdmin: admin@localhost.test',
        '',
      ].join('\n'),
      {},
      'storage',
    ],
    [
      'a kubernetes runtime',
      renderedYaml().replace(
        '    cloud: local\n',
        '    cloud: local\n    runtime:\n      default: kubernetes\n',
      ),
      {},
      'environments.local.runtime.default',
    ],
    [
      'an ANTHROPIC_BASE_URL that is not an http(s) URL',
      renderedYaml(),
      { ANTHROPIC_BASE_URL: 'ftp://llm.example.com' },
      'ANTHROPIC_BASE_URL',
    ],
  ] as const)('refuses %s by name, with nothing forked', async (_name, yaml, env, field) => {
    const cwd = await project({ yaml });
    const { run } = await dev(cwd, { env });
    expect(run.code, run.stderr).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(field);
    expect(run.stderr).not.toContain('ftp://');
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });

  it('refuses a malformed project file with its line and column', async () => {
    const cwd = await project({ yaml: `${renderedYaml()}surprise: true\n` });
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toMatch(/^error: agent-workspace\.yaml:\d+:\d+: /u);
  });
});

describe('aw dev (issue #451): refuses unknown input', () => {
  it.each([
    [4000, 'gateway'],
    [8080, 'runner'],
  ] as const)(
    'refuses the reserved port %i (the runtime %s) at its line, before resolving or forking a runtime (issue #560)',
    async (port, service) => {
      const yaml = renderedYaml().replace(
        '    cloud: local\n',
        `    cloud: local\n    port: ${String(port)}\n`,
      );
      // With a runtime installed, and with none: the file is refused before either matters.
      for (const options of [{ yaml }, { yaml, embeddedVersion: null }]) {
        const cwd = await project(options);
        const { run } = await dev(cwd);
        expect(run.code, run.stderr).toBe(EXIT_CODE.usage);
        expect(run.stderr).toMatch(
          new RegExp(
            `^error: agent-workspace\\.yaml:\\d+:5: environments\\.local\\.port is reserved by the local runtime's ${service} \\(${String(port)}\\); choose another port\\n`,
            'u',
          ),
        );
        expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
      }
    },
  );

  it.each([
    ['--url', ['--url', 'http://x.example.com']],
    ['--json', ['--json']],
    ['--profile', ['--profile', 'p']],
    ['--api-key-stdin', ['--api-key-stdin']],
    ['--timeout', ['--timeout', '5']],
    ['--yes', ['--yes']],
  ] as const)('refuses %s by name rather than accepting and ignoring it', async (flag, argv) => {
    const cwd = await project();
    const { run } = await dev(cwd, { argv });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain(`aw dev does not take ${flag}`);
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });
});
