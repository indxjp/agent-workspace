/**
 * Issue #827/#832: `.github/workflows/e2b-template.yml` builds the E2B runtime template and prints
 * the `<template>:<build_id>` pin that `E2B_RUNTIME_TEMPLATE` holds. The build talks to a fake
 * `fetch`, never to E2B.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildTemplate,
  builderResources,
  defaultRuntimeImage,
  failureSummary,
  formatLogEntry,
  sanitizeLogLine,
  TEMPLATE_NAME,
  templatePin,
  TOOL_HOST_TEMPLATE_NAME,
} from '../../infra/e2b/build-template.mjs';
import {
  APP_DIR,
  BUILD_COMMANDS,
  BUILD_ENV,
  CONTEXT_PATHS,
  INSTALL_COMMAND,
  PRUNE_COMMAND,
  RUN_ENV,
  STRIP_COMMAND,
  toolHostBuild,
} from '../../infra/e2b/tool-host-template.mjs';
import {
  buildCommand,
  contextPaths,
  installCommand,
  linkCommand,
  OWNER_COMMAND,
  pnpmFetchCommand,
  pnpmInstallCommand,
  pruneCommand,
  RUN_ENV as RUNTIME_RUN_ENV,
  runtimeBuild,
  SRV_DIR,
  STRIP_COMMAND as RUNTIME_STRIP_COMMAND,
  verifyLabelCommand,
  WORKSPACE_DIR,
} from '../../infra/e2b/runtime-template.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BUILD_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const IMAGE = 'ghcr.io/indxjp/agent-workspace/runtime-claude-agent-sdk:0.6.0';
const KEY = 'e2b_test_key_value';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly key: string | undefined;
}

function fakeE2b(statuses: readonly string[], overrides: Record<string, Response> = {}) {
  const calls: Call[] = [];
  let polled = 0;
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      key: headers.get('x-api-key') ?? undefined,
    });
    const override = overrides[`${method} ${new URL(url).pathname}`];
    if (override !== undefined) return Promise.resolve(override);
    if (method === 'POST' && url.endsWith('/v3/templates')) {
      return Promise.resolve(
        Response.json({ templateID: 'tpl_1', buildID: BUILD_ID }, { status: 202 }),
      );
    }
    if (method === 'POST') return Promise.resolve(new Response(null, { status: 202 }));
    const status = statuses[Math.min(polled, statuses.length - 1)];
    polled += 1;
    return Promise.resolve(Response.json({ status }));
  };
  return { fake, calls };
}

const noSleep = () => Promise.resolve();

describe('templatePin', () => {
  it('joins the template and a UUID build id, and refuses anything else', () => {
    expect(templatePin('aw-runtime', BUILD_ID)).toBe(`aw-runtime:${BUILD_ID}`);
    expect(() => templatePin('aw-runtime', 'latest')).toThrow('e2b reported no build id');
    expect(() => templatePin('aw-runtime', undefined)).toThrow('e2b reported no build id');
  });
});

describe('buildTemplate', () => {
  it('creates the template, builds it from the image, waits for ready and returns the pin', async () => {
    const { fake, calls } = fakeE2b(['building', 'building', 'ready']);
    const pin = await buildTemplate({ apiKey: KEY, image: IMAGE, fetch: fake, sleep: noSleep });
    expect(pin).toBe(`${TEMPLATE_NAME}:${BUILD_ID}`);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /v3/templates',
      `POST /v2/templates/tpl_1/builds/${BUILD_ID}`,
      `GET /templates/tpl_1/builds/${BUILD_ID}/status`,
      `GET /templates/tpl_1/builds/${BUILD_ID}/status`,
      `GET /templates/tpl_1/builds/${BUILD_ID}/status`,
    ]);
    expect(calls[1]?.body).toEqual({ fromImage: IMAGE, force: true });
    expect(calls.every((call) => call.key === KEY)).toBe(true);
  });

  it('fails without the key in the message when the build errors', async () => {
    const { fake } = fakeE2b(['error']);
    await expect(
      buildTemplate({ apiKey: KEY, image: IMAGE, fetch: fake, sleep: noSleep }),
    ).rejects.toThrow('e2b template build failed');
  });

  it('names the operation and status only when E2B refuses', async () => {
    const { fake } = fakeE2b([], {
      'POST /v3/templates': new Response(`denied for ${KEY}`, { status: 401 }),
    });
    const failure = await buildTemplate({
      apiKey: KEY,
      image: IMAGE,
      fetch: fake,
      sleep: noSleep,
    }).catch((error: unknown) => error);
    expect(failure).toEqual(new Error('e2b template create failed with status 401'));
  });

  it('refuses a create answer without a build id before building', async () => {
    const { fake, calls } = fakeE2b([], {
      'POST /v3/templates': Response.json({ templateID: 'tpl_1' }, { status: 202 }),
    });
    await expect(
      buildTemplate({ apiKey: KEY, image: IMAGE, fetch: fake, sleep: noSleep }),
    ).rejects.toThrow('e2b reported no build id');
    expect(calls).toHaveLength(1);
  });

  it('times out a build that never becomes ready', async () => {
    const { fake } = fakeE2b(['building']);
    let clock = 0;
    await expect(
      buildTemplate({
        apiKey: KEY,
        image: IMAGE,
        fetch: fake,
        sleep: noSleep,
        now: () => (clock += 400_000),
      }),
    ).rejects.toThrow('e2b template build timed out');
  });

  it('refuses an empty key and a malformed image before any request', async () => {
    const { fake, calls } = fakeE2b(['ready']);
    await expect(buildTemplate({ apiKey: '', image: IMAGE, fetch: fake })).rejects.toThrow(
      'E2B_API_KEY is empty',
    );
    await expect(buildTemplate({ apiKey: KEY, image: '--flag x', fetch: fake })).rejects.toThrow(
      'RUNTIME_IMAGE is not an image reference',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('E2B build logs (#827)', () => {
  const errored = JSON.parse(
    readFileSync(path.join(ROOT, 'tests/release/fixtures/e2b-build-status-error.json'), 'utf8'),
  ) as {
    status: string;
    logEntries: object[];
    reason: { logEntries: { message: string }[] };
  };
  const [first, second] = errored.logEntries;
  const long = { ...errored.reason.logEntries[0], message: 'x'.repeat(1000) };

  function statusSequence(bodies: readonly unknown[]) {
    const offsets: (string | null)[] = [];
    let polled = 0;
    const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (init?.method === 'POST' && url.pathname === '/v3/templates') {
        return Promise.resolve(
          Response.json({ templateID: 'tpl_1', buildID: BUILD_ID }, { status: 202 }),
        );
      }
      if (init?.method === 'POST') return Promise.resolve(new Response(null, { status: 202 }));
      offsets.push(url.searchParams.get('logsOffset'));
      polled += 1;
      return Promise.resolve(Response.json(bodies[Math.min(polled, bodies.length) - 1]));
    };
    return { fake, offsets };
  }

  it('reads each entry once, drains an errored build, and reports the sanitized reason and step', async () => {
    const { fake, offsets } = statusSequence([
      { status: 'building', logEntries: [first] },
      { ...errored, logEntries: [second] },
      { ...errored, logEntries: [], reason: { ...errored.reason, logEntries: [long] } },
    ]);
    const lines: string[] = [];
    const failure = await buildTemplate({
      apiKey: KEY,
      image: IMAGE,
      fetch: fake,
      sleep: noSleep,
      onLog: (line) => lines.push(line),
    }).catch((error: unknown) => error);

    expect(offsets).toEqual(['0', '1', '2']);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('[info] Pulling image node:24.21.0-bookworm-slim');
    expect(lines[1]).toBe('[error] 2: fetch <url> with key *** failed');
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(
      /^e2b template build failed at step 2: Build failed: step 2 exited with code 1 \(see <url> \*\*\* :: ?set-output/u,
    );
    for (const text of [message, ...lines]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('https://');
      expect(text).not.toContain('X-Amz-Signature');
      expect(text).not.toContain('\u001b');
      expect(text.length).toBeLessThanOrEqual(300);
    }
  });

  it('falls back to the plain failure when the logs and reason are missing or malformed', async () => {
    for (const bodies of [
      [{ status: 'error' }],
      [{ status: 'error', logEntries: 'x', reason: { message: 5, step: 'a b' } }],
      [
        { status: 'error', logEntries: [null, 1, { message: 7 }], reason: 'no' },
        { status: 'error', logEntries: [] },
      ],
    ]) {
      const { fake } = statusSequence(bodies);
      const lines: string[] = [];
      await expect(
        buildTemplate({
          apiKey: KEY,
          image: IMAGE,
          fetch: fake,
          sleep: noSleep,
          onLog: (line) => lines.push(line),
        }),
      ).rejects.toEqual(new Error('e2b template build failed'));
      expect(lines).toEqual([]);
    }
  });

  it('paces and caps the drain of an errored build that keeps returning entries', async () => {
    const { fake, offsets } = statusSequence([{ ...errored, logEntries: [first] }]);
    const sleeps: number[] = [];
    await expect(
      buildTemplate({
        apiKey: KEY,
        image: IMAGE,
        fetch: fake,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        onLog: () => undefined,
      }),
    ).rejects.toThrow(/^e2b template build failed at step 2/u);
    expect(offsets).toHaveLength(11);
    expect(sleeps).toHaveLength(10);
  });

  it('prints entries of a build that succeeds and still returns the pin', async () => {
    const { fake } = statusSequence([
      { status: 'building', logEntries: [first] },
      { status: 'ready', logEntries: [] },
    ]);
    const lines: string[] = [];
    const pin = await buildTemplate({
      apiKey: KEY,
      image: IMAGE,
      fetch: fake,
      sleep: noSleep,
      onLog: (line) => lines.push(line),
    });
    expect(pin).toBe(`${TEMPLATE_NAME}:${BUILD_ID}`);
    expect(lines).toEqual(['[info] Pulling image node:24.21.0-bookworm-slim']);
  });

  it('sanitizes a line: ANSI, control characters, key, URLs, workflow commands, length', () => {
    expect(sanitizeLogLine(`\u001b[1;31mboom\u001b[0m\r\n${KEY}`, KEY)).toBe('boom  ***');
    expect(sanitizeLogLine('GET http://a.example/p?sig=1 and https://b.example', KEY)).toBe(
      'GET <url> and <url>',
    );
    for (const command of ['::error::x', '  ::add-mask::k', '\n::stop-commands::t']) {
      expect(sanitizeLogLine(command, KEY)).not.toMatch(/^\s*::/u);
    }
    expect(sanitizeLogLine('y'.repeat(1000), KEY)).toHaveLength(300);
    expect(formatLogEntry({ level: 'in fo', step: 'a'.repeat(33), message: 'm' }, KEY)).toBe('m');
    expect(formatLogEntry({ message: 1 }, KEY)).toBeUndefined();
    expect(formatLogEntry(null, KEY)).toBeUndefined();
  });

  it('fences the failure summary so the log tail cannot close it, and caps it', () => {
    const summary = failureSummary('tool-host', 'e2b template build failed', [
      '~~~~',
      'z'.repeat(40_000),
    ]);
    expect(summary).toMatch(/^## E2B tool-host template failed\n/u);
    expect(summary.split('~~~~')).toHaveLength(3);
    expect(summary.length).toBeLessThan(17_000);
  });
});

describe('template resources (#827)', () => {
  it('sends cpuCount and memoryMB in the create body only when given', async () => {
    const sized = fakeE2b(['ready']);
    await buildTemplate({
      apiKey: KEY,
      image: IMAGE,
      cpuCount: 2,
      memoryMB: 4096,
      fetch: sized.fake,
      sleep: noSleep,
    });
    expect(sized.calls[0]?.body).toEqual({ name: TEMPLATE_NAME, cpuCount: 2, memoryMB: 4096 });

    const plain = fakeE2b(['ready']);
    await buildTemplate({ apiKey: KEY, image: IMAGE, fetch: plain.fake, sleep: noSleep });
    expect(plain.calls[0]?.body).toEqual({ name: TEMPLATE_NAME });
  });

  it('defaults to 2 vCPU / 4096 MiB and refuses a value out of bounds without echoing it', () => {
    expect(builderResources({})).toEqual({ cpuCount: 2, memoryMB: 4096 });
    expect(builderResources({ E2B_CPU_COUNT: '', E2B_MEMORY_MB: '' })).toEqual({
      cpuCount: 2,
      memoryMB: 4096,
    });
    expect(builderResources({ E2B_CPU_COUNT: '4', E2B_MEMORY_MB: '8192' })).toEqual({
      cpuCount: 4,
      memoryMB: 8192,
    });
    for (const cpu of ['0', '9', '2.5', '-1', 'abc', '1e1']) {
      expect(() => builderResources({ E2B_CPU_COUNT: cpu })).toThrow(
        'E2B_CPU_COUNT is not a whole number from 1 to 8',
      );
    }
    for (const memory of ['256', '16384', '4095', '4096.0', 'big']) {
      expect(() => builderResources({ E2B_MEMORY_MB: memory })).toThrow(
        new Error('E2B_MEMORY_MB is not an even whole number from 512 to 8192'),
      );
    }
  });

  it('names the resources in a failure summary when it has them', () => {
    const resources = { cpuCount: 2, memoryMB: 4096 };
    expect(failureSummary('tool-host', 'boom', [], resources)).toContain(
      'Builder resources: 2 vCPU / 4096 MiB',
    );
    expect(failureSummary('tool-host', 'boom', [])).not.toContain('Builder resources');
  });

  it('installs the tool host with low concurrency, scoped to its own dependencies', () => {
    expect(INSTALL_COMMAND).toContain('--network-concurrency=4');
    expect(INSTALL_COMMAND).toContain('--child-concurrency=1');
    expect(INSTALL_COMMAND).toMatch(/--filter @agent-workspace\/tool-host\.\.\.$/u);
  });
});

describe('defaultRuntimeImage', () => {
  it('is the released claude-agent-sdk runtime image', () => {
    expect(defaultRuntimeImage()).toMatch(
      /^ghcr\.io\/indxjp\/agent-workspace\/runtime-claude-agent-sdk:\d+\.\d+\.\d+/u,
    );
  });
});

describe('the tool-host template (#827)', () => {
  const dockerfile = readFileSync(path.join(ROOT, 'tool-host.Dockerfile'), 'utf8');
  const build = toolHostBuild();
  const upload = build.uploads[0];

  it('replays the Dockerfile build stage: same base image, pnpm, COPY paths and commands', () => {
    expect(TOOL_HOST_TEMPLATE_NAME).not.toBe(TEMPLATE_NAME);
    expect(dockerfile).toContain(`ARG NODE_IMAGE=${build.image}`);
    const pnpm = /corepack prepare pnpm@(\S+) --activate/u.exec(dockerfile)?.[1];
    expect(build.steps.map((step) => step.args[0])).toContain(
      `corepack enable && corepack prepare pnpm@${pnpm} --activate`,
    );
    const copied = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gmu)].flatMap((match) =>
      (match[1] ?? '').split(' '),
    );
    expect(copied.length).toBeGreaterThan(0);
    for (const source of copied) {
      expect(
        CONTEXT_PATHS.some((entry) => source === entry || source.startsWith(`${entry}/`)),
      ).toBe(true);
    }
    expect(dockerfile).toContain(INSTALL_COMMAND);
    expect(dockerfile).toContain(PRUNE_COMMAND.slice(PRUNE_COMMAND.indexOf('pnpm install')));
    for (const command of BUILD_COMMANDS) expect(dockerfile).toContain(command.slice(5));
    expect(STRIP_COMMAND).toContain('upgrade -y --no-install-recommends');
    expect(STRIP_COMMAND).toContain('--force-confold');
    const removed = /^FROM \$\{NODE_IMAGE\} AS tool-host\nRUN ([\s\S]*?)\n(?!\s)/mu
      .exec(dockerfile)?.[1]
      ?.match(/\/usr\/local\/\S+/gu);
    expect(removed).toEqual(
      expect.arrayContaining(['/usr/local/lib/node_modules', '/usr/local/bin/npm']),
    );
    for (const target of removed ?? []) expect(STRIP_COMMAND).toContain(target);
    expect(dockerfile).toContain(`CMD ["node", "${APP_DIR}/packages/tool-host/dist/main.js"]`);
  });

  it('opens like fromDockerfile, replays the Dockerfile ENVs and ends as the non-root user', () => {
    expect(build.steps.map((step) => step.type)).toEqual([
      'USER',
      'WORKDIR',
      'ENV',
      'COPY',
      'WORKDIR',
      'RUN',
      'RUN',
      'RUN',
      'RUN',
      'ENV',
      'USER',
    ]);
    expect(build.steps[0]?.args).toEqual(['root']);
    expect(build.steps[1]?.args).toEqual(['/']);
    expect(build.steps[4]?.args).toEqual([APP_DIR]);
    expect(build.steps[10]?.args).toEqual(['node']);
    expect(dockerfile).toContain('USER 1000:1000');
    for (const env of [BUILD_ENV, RUN_ENV]) {
      for (let index = 0; index < env.length; index += 2) {
        const [key, value] = [env[index], env[index + 1]];
        if (key === 'DEBIAN_FRONTEND') continue;
        expect(dockerfile).toMatch(new RegExp(`${key}=${value?.replaceAll('.', '\\.')}\\b`, 'u'));
      }
    }
    expect(build.steps[2]?.args).toEqual(BUILD_ENV);
    expect(build.steps[9]?.args).toEqual(RUN_ENV);
    const commands = build.steps.filter((step) => step.type === 'RUN').map((step) => step.args[0]);
    for (const command of commands) expect(command).not.toMatch(/\bcd |export /u);
  });

  it('ships one deterministic tar.gz of tracked files under its sha256', () => {
    expect(upload).toBeDefined();
    expect(build.steps[3]).toEqual({
      type: 'COPY',
      args: ['.', APP_DIR, '', ''],
      filesHash: upload?.hash,
    });
    expect(upload?.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(toolHostBuild().uploads[0]?.hash).toBe(upload?.hash);
    expect([...(upload?.archive.subarray(0, 2) ?? [])]).toEqual([0x1f, 0x8b]);
  });

  it('uploads the context, builds with steps and pins <template>:<build_id>', async () => {
    const uploadLink: unknown = JSON.parse(
      readFileSync(path.join(ROOT, 'tests/release/fixtures/e2b-file-upload-link.json'), 'utf8'),
    );
    const putHeaders: Headers[] = [];
    const calls: { method: string; url: string; key: string | null; body: unknown }[] = [];
    const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = init?.method ?? 'GET';
      if (method === 'PUT') putHeaders.push(new Headers(init?.headers));
      calls.push({
        method,
        url,
        key: new Headers(init?.headers).get('x-api-key'),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      if (url.endsWith('/v3/templates')) {
        return Promise.resolve(
          Response.json({ templateID: 'tpl_1', buildID: BUILD_ID }, { status: 202 }),
        );
      }
      if (url.includes('/files/')) {
        return Promise.resolve(Response.json(uploadLink, { status: 201 }));
      }
      if (method === 'PUT') return Promise.resolve(new Response(null, { status: 200 }));
      if (method === 'POST') return Promise.resolve(new Response(null, { status: 202 }));
      return Promise.resolve(Response.json({ status: 'ready' }));
    };
    const pin = await buildTemplate({
      apiKey: KEY,
      name: TOOL_HOST_TEMPLATE_NAME,
      ...build,
      fetch: fake,
      sleep: noSleep,
    });
    expect(pin).toBe(`${TOOL_HOST_TEMPLATE_NAME}:${BUILD_ID}`);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /v3/templates',
      `GET /templates/tpl_1/files/${upload?.hash}`,
      'PUT /ctx',
      `POST /v2/templates/tpl_1/builds/${BUILD_ID}`,
      `GET /templates/tpl_1/builds/${BUILD_ID}/status`,
    ]);
    expect(calls[2]?.body).toBe(upload?.archive);
    // Exactly E2B's headers plus the real length: the fixture's stale length is replaced and no
    // content type of ours is merged into the signed one.
    expect(putHeaders).toHaveLength(1);
    expect([...(putHeaders[0] ?? [])].sort()).toEqual([
      ['content-length', String(upload?.archive.byteLength)],
      ['content-type', 'application/octet-stream'],
    ]);
    expect(calls[3]?.body).toEqual({ fromImage: build.image, force: true, steps: build.steps });
    // The key goes to E2B's API only, never to the presigned upload URL.
    expect(calls.map((call) => call.key)).toEqual([KEY, KEY, null, KEY, KEY]);
  });

  it('skips an upload E2B holds, and refuses a bad upload answer without the key', async () => {
    const hash = 'a'.repeat(64);
    const make = (link: Response, put?: Response) => {
      const requests: string[] = [];
      const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = input instanceof Request ? input.url : input.toString();
        requests.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/v3/templates')) {
          return Promise.resolve(
            Response.json({ templateID: 'tpl_1', buildID: BUILD_ID }, { status: 202 }),
          );
        }
        if (url.includes('/files/')) return Promise.resolve(link);
        if (init?.method === 'PUT') return Promise.resolve(put ?? new Response(null));
        return Promise.resolve(new Response(null, { status: 202 }));
      };
      return { fake, requests };
    };
    const options = {
      apiKey: KEY,
      image: 'node:24',
      uploads: [{ hash, archive: Uint8Array.of(1) }],
    };

    const present = make(Response.json({ present: true }, { status: 201 }));
    const stopped = await buildTemplate({
      ...options,
      fetch: present.fake,
      sleep: noSleep,
      now: () => Infinity,
    }).catch((error: unknown) => error);
    expect(present.requests.some((request) => request.startsWith('PUT'))).toBe(false);
    const linked = present.requests.indexOf(
      `GET https://api.e2b.app/templates/tpl_1/files/${hash}`,
    );
    expect(linked).toBeGreaterThan(-1);
    expect(
      present.requests.indexOf(`POST https://api.e2b.app/v2/templates/tpl_1/builds/${BUILD_ID}`),
    ).toBeGreaterThan(linked);
    expect(stopped).toEqual(new Error('e2b build status failed with status 202'));

    const refused = make(
      Response.json({ present: false, url: 'https://upload.example/x' }, { status: 201 }),
      new Response(`denied ${KEY}`, { status: 403 }),
    );
    const failure = await buildTemplate({ ...options, fetch: refused.fake }).catch(
      (error: unknown) => error,
    );
    expect(failure).toEqual(new Error('e2b context upload failed with status 403'));

    const signed = make(
      Response.json({ present: false, url: 'https://upload.example/x?sig=secret' }),
      new Response(
        `<Error><Code>SignatureDoesNotMatch</Code><Message>${KEY}</Message><StringToSign>s</StringToSign></Error>`,
        { status: 403 },
      ),
    );
    const named = await buildTemplate({ ...options, fetch: signed.fake }).catch(
      (error: unknown) => error,
    );
    expect(named).toEqual(
      new Error('e2b context upload failed with status 403 (SignatureDoesNotMatch)'),
    );

    const malformed = make(
      Response.json({
        present: false,
        url: 'https://upload.example/x',
        headers: { 'x-amz-security-token': 'a\nb' },
      }),
    );
    const invalid = await buildTemplate({ ...options, fetch: malformed.fake }).catch(
      (error: unknown) => error,
    );
    expect(invalid).toEqual(new Error('e2b reported an invalid upload header'));
    expect(malformed.requests.some((request) => request.startsWith('PUT'))).toBe(false);

    const plain = make(Response.json({ present: false, url: 'http://insecure.example/x' }));
    await expect(buildTemplate({ ...options, fetch: plain.fake })).rejects.toThrow(
      'e2b reported no upload url',
    );
    await expect(
      buildTemplate({
        ...options,
        uploads: [{ hash: '../x', archive: Uint8Array.of(1) }],
        fetch: plain.fake,
      }),
    ).rejects.toThrow('e2b context hash is not a sha256');
  });
});

describe('the runtime template built from the checkout (#827)', () => {
  const dockerfile = readFileSync(path.join(ROOT, 'runtime.Dockerfile'), 'utf8');
  const arg = (name: string) =>
    new RegExp(`^ARG ${name}=(\\S+)$`, 'mu').exec(dockerfile)?.[1] ?? '';
  const build = runtimeBuild();
  const engine = arg('ENGINE');
  const commands = build.steps.filter((step) => step.type === 'RUN').map((step) => step.args[0]);

  it('replays the Dockerfile: same base image, engine, versions, COPY paths and commands', () => {
    expect(build.image).toBe(arg('NODE_IMAGE'));
    expect(engine).not.toBe('');
    expect(commands).toContain(verifyLabelCommand(engine, arg('ENGINE_VERSION')));
    expect(commands).toContain(
      `corepack enable && corepack prepare pnpm@${/corepack prepare pnpm@(\S+) --activate/u.exec(dockerfile)?.[1]} --activate`,
    );
    const paths = contextPaths(engine);
    const copied = [
      ...dockerfile.matchAll(/^COPY (?!--from)(?:--chown=\S+ )?(.+) \S+$/gmu),
    ].flatMap((match) => (match[1] ?? '').trim().split(/\s+/u));
    expect(copied.length).toBeGreaterThan(0);
    for (const source of copied.map((each) => each.replaceAll('${ENGINE}', engine))) {
      expect(paths.some((entry) => source === entry || source.startsWith(`${entry}/`))).toBe(true);
    }
    const filters =
      '--filter "@agent-workspace/runner..." --filter "@agent-workspace/engine-${ENGINE}..."';
    expect(dockerfile).toContain(`pnpm install --frozen-lockfile ${filters}`);
    expect(installCommand(engine)).toContain(filters.replaceAll('${ENGINE}', engine));
    expect(installCommand(engine)).toContain('--network-concurrency=4 --child-concurrency=1');
    expect(dockerfile).toContain(`pnpm ${filters} build`);
    expect(buildCommand(engine)).toBe(`pnpm ${filters.replaceAll('${ENGINE}', engine)} build`);
    expect(dockerfile).toContain(
      pruneCommand('${ENGINE}').slice(pruneCommand('${ENGINE}').indexOf('pnpm install')),
    );
    expect(dockerfile).toContain(
      'ln -sfn ../../../../packages/engine-${ENGINE} apps/runner/node_modules/@agent-workspace/engine-${ENGINE}',
    );
    expect(linkCommand('${ENGINE}')).toContain(
      'ln -sfn ../../../../packages/engine-${ENGINE} apps/runner/node_modules/@agent-workspace/engine-${ENGINE}',
    );
    expect(dockerfile).toContain("await import('@agent-workspace/engine-${ENGINE}')");
    expect(linkCommand('${ENGINE}')).toContain("await import('@agent-workspace/engine-${ENGINE}')");
  });

  it('removes the package managers like the final stage and installs the pinned pnpm tarball', () => {
    expect(RUNTIME_STRIP_COMMAND).toContain('upgrade -y --no-install-recommends');
    const removed =
      /^FROM \$\{NODE_IMAGE\} AS runtime\n(?:ARG .*\n)*# .*\n(?:# .*\n)*RUN ([\s\S]*?)\n(?!\s)/mu
        .exec(dockerfile)?.[1]
        ?.match(/\/(?:usr\/local|opt|root)\/[^\s\\]+/gu);
    expect(removed).toEqual(
      expect.arrayContaining(['/usr/local/lib/node_modules', '/usr/local/bin/npm']),
    );
    for (const target of removed ?? []) expect(RUNTIME_STRIP_COMMAND).toContain(target);
    expect(RUNTIME_STRIP_COMMAND).toContain('/usr/local/bin/pnpm');
    const version = arg('PNPM_VERSION');
    const sha256 = { x64: arg('PNPM_SHA256_AMD64'), arm64: arg('PNPM_SHA256_ARM64') };
    expect(sha256.x64).toMatch(/^[0-9a-f]{64}$/u);
    expect(sha256.arm64).toMatch(/^[0-9a-f]{64}$/u);
    for (const arch of ['x64', 'arm64']) {
      expect(dockerfile).toContain(
        `https://registry.npmjs.org/@pnpm/exe.linux-${arch}/-/exe.linux-${arch}-\${PNPM_VERSION}.tgz`,
      );
    }
    const fetchStep = pnpmFetchCommand(version, sha256);
    expect(commands).toContain(fetchStep);
    expect(fetchStep).toContain(`-${version}.tgz`);
    expect(fetchStep).toContain(`{x64:'${sha256.x64}',arm64:'${sha256.arm64}'}[process.arch]`);
    expect(fetchStep).toContain('!==s)throw');
    expect(commands).toContain(pnpmInstallCommand);
    for (const line of [
      'tar -xzf /tmp/pnpm.tgz -C /opt/pnpm --strip-components=1 --no-same-owner',
      'ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm',
      'exec /usr/local/bin/node /opt/npx/npx.mjs',
      'ln -s /usr/local/bin/npx /usr/bin/npx',
    ]) {
      expect(dockerfile).toContain(line);
      expect(pnpmInstallCommand).toContain(line);
    }
  });

  it('ends as the node user in /workspace with the final stage environment, entry path included', () => {
    expect(build.steps.map((step) => step.type)).toEqual([
      'USER',
      'WORKDIR',
      'ENV',
      'COPY',
      'WORKDIR',
      'RUN',
      'RUN',
      'RUN',
      'RUN',
      'RUN',
      'RUN',
      'RUN',
      'RUN',
      'RUN',
      'ENV',
      'WORKDIR',
      'USER',
    ]);
    expect(build.steps.at(-1)?.args).toEqual(['node']);
    expect(build.steps.at(-2)?.args).toEqual([WORKSPACE_DIR]);
    expect(build.steps.at(-3)?.args).toEqual(RUNTIME_RUN_ENV);
    for (let index = 0; index < RUNTIME_RUN_ENV.length; index += 2) {
      expect(dockerfile).toMatch(
        new RegExp(
          `${RUNTIME_RUN_ENV[index]}=${RUNTIME_RUN_ENV[index + 1]?.replaceAll('.', '\\.')}\\b`,
          'u',
        ),
      );
    }
    expect(OWNER_COMMAND).toContain(`chown -R node:node ${SRV_DIR} ${WORKSPACE_DIR}`);
    expect(dockerfile).toContain('RUN mkdir -p /workspace && chown node:node /workspace');
    expect(dockerfile).toContain('CMD ["node", "/srv/apps/runner/dist/index.js"]');
    expect(readFileSync(path.join(ROOT, 'packages/runtime/src/external/e2b.ts'), 'utf8')).toContain(
      "const RUNNER_ENTRY = '/srv/apps/runner/dist/index.js'",
    );
    for (const command of commands) expect(command).not.toMatch(/\bexport /u);
  });

  it('ships one deterministic tar.gz of tracked files under its sha256, and leaves the tool host alone', () => {
    const upload = build.uploads[0];
    expect(build.uploads).toHaveLength(1);
    expect(build.steps[3]).toEqual({
      type: 'COPY',
      args: ['.', SRV_DIR, '', ''],
      filesHash: upload?.hash,
    });
    expect(upload?.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(runtimeBuild().uploads[0]?.hash).toBe(upload?.hash);
    expect(toolHostBuild().uploads[0]?.hash).not.toBe(upload?.hash);
    expect([...(upload?.archive.subarray(0, 2) ?? [])]).toEqual([0x1f, 0x8b]);
  });
});

describe('e2b-template workflow', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/e2b-template.yml'), 'utf8');

  it('is manual, main only, in providers-live, and passes the key only through env', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/mu);
    expect(workflow).not.toMatch(/^ {2}(?:push|pull_request|schedule):/mu);
    expect(workflow).toContain(
      "if: github.repository_owner == 'INDXDev' && (github.ref == 'refs/heads/main')",
    );
    expect(workflow).toContain('environment: providers-live');
    expect(workflow).toContain('E2B_API_KEY: ${{ secrets.E2B_API_KEY }}');
    expect(workflow.match(/secrets\.E2B_API_KEY/gu)).toHaveLength(1);
  });

  it('chooses the runtime or the tool-host template, defaulting to the runtime', () => {
    expect(workflow).toMatch(/template:\n[\s\S]*?default: runtime\n\s+type: choice/u);
    expect(workflow).toContain('TEMPLATE_KIND: ${{ inputs.template }}');
  });

  it('sizes the template through bounded choice inputs passed by env', () => {
    for (const [input, fallback, options] of [
      ['cpu_count', '2', ['2', '4', '8']],
      ['memory_mb', '4096', ['2048', '4096', '8192']],
    ] as const) {
      const block = new RegExp(`\\n {6}${input}:\\n([\\s\\S]*?)(?=\\n {6}\\w|\\n\\w)`, 'u').exec(
        workflow,
      )?.[1];
      expect(block).toContain(`default: '${fallback}'`);
      expect(block).toContain('type: choice');
      expect([...(block ?? '').matchAll(/^ {10}- '(\d+)'$/gmu)].map((match) => match[1])).toEqual(
        options,
      );
    }
    expect(workflow).toContain('E2B_CPU_COUNT: ${{ inputs.cpu_count }}');
    expect(workflow).toContain('E2B_MEMORY_MB: ${{ inputs.memory_mb }}');
  });
});
