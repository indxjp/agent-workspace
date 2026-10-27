/**
 * #370 (docs/adr/0086): one list of platform images, shared by the generator and the image release
 * workflow.
 *
 * `packages/cli/src/release-images.json` names what the generator pins. `infra/release/images.mjs`
 * turns it into the build plan, adding one runtime image per engine (ADR-0073), and
 * `infra/release/build-and-push.sh` and `.github/workflows/images.yml` read that plan instead of
 * naming an image themselves. This suite holds the three to one another.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isSlsaProvenance } from '../../infra/release/check-provenance.mjs';
import { imageRevision } from '../../infra/release/image-revision.mjs';
import { readReleaseImages, releasePlan } from '../../infra/release/images.mjs';
import {
  ATTEMPTS,
  bearerChallenge,
  fetchWithRetry,
  githubOwnerExists,
  probeImage,
  RegistryUnreachable,
  smokeDecision,
} from '../../infra/release/smoke-create.mjs';
import { engineImages } from '../../scripts/engine-images.mjs';
import { releaseImages } from '../../scripts/release/check.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\sh.exe' : 'sh';
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('the platform image list (#370)', () => {
  const { images } = readReleaseImages();
  const plan = releasePlan();
  const names = plan.map((image) => image.name);

  it('builds every image the generator pins', () => {
    for (const [field, name] of Object.entries(images)) {
      expect(names, `${field}=${name}`).toContain(name);
    }
  });

  it('is the generator images, the egress proxy, the tool host and one runtime image per engine, and nothing else', () => {
    expect(names).toEqual([
      images['web'],
      images['gateway'],
      images['runner'],
      'egress-proxy',
      'tool-host',
      ...engineImages().map((engine) => engine.image),
    ]);
    expect(names).toEqual(releaseImages(ROOT));
  });

  it('selects an explicit Dockerfile target for every image', () => {
    for (const image of plan) {
      const dockerfile = read(image.dockerfile);
      expect(dockerfile, image.name).toMatch(new RegExp(`^FROM \\S+ AS ${image.target}$`, 'mu'));
      expect(image.engine === null, image.name).toBe(!image.name.startsWith('runtime-'));
    }
  });

  it('refuses a generator image that nothing builds', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aw-release-images-'));
    temporary.push(root);
    mkdirSync(path.join(root, 'packages/cli/src'), { recursive: true });
    writeFileSync(
      path.join(root, 'packages/cli/src/release-images.json'),
      JSON.stringify({
        registry: 'ghcr.io/example',
        version: '1.0.0',
        images: { web: 'web', gateway: 'gateway', runner: 'runner', runtime: 'runtime-nothing' },
      }),
    );
    expect(() => releasePlan(root)).toThrow(/RELEASE_IMAGE_UNBUILT: .*runtime-nothing/u);
  });

  it.each([
    [{ registry: 'ghcr.io/example', version: '1.0.0', images: null }, /must name a registry/u],
    [{ registry: 'ghcr.io/example', version: '1.0.0', images: ['web'] }, /must name a registry/u],
    [{ registry: 'ghcr.io/example', version: 'latest', images: {} }, /not a semantic version/u],
    [{ registry: 'ghcr.io/example', version: '1.0', images: {} }, /not a semantic version/u],
  ])('refuses the release document %j', (document, message) => {
    const root = mkdtempSync(path.join(tmpdir(), 'aw-release-images-'));
    temporary.push(root);
    mkdirSync(path.join(root, 'packages/cli/src'), { recursive: true });
    writeFileSync(
      path.join(root, 'packages/cli/src/release-images.json'),
      JSON.stringify(document),
    );
    expect(() => readReleaseImages(root)).toThrow(message);
  });
});

describe('the image release script reads the plan', () => {
  it('names no image itself', () => {
    const script = read('infra/release/build-and-push.sh');
    expect(script).toContain('node infra/release/images.mjs');
    expect(script).not.toMatch(/^publish (web|gateway|runner) /mu);
  });

  it('signs and attests what release.yml verifies', () => {
    const script = read('infra/release/build-and-push.sh');
    const verified = read('.github/workflows/release.yml');
    for (const type of ['spdxjson', 'slsaprovenance']) {
      expect(verified).toContain(`cosign verify-attestation "$image" --type ${type}`);
      expect(script).toContain(`cosign attest --yes --type ${type}`);
    }
    expect(script).toContain('cosign sign --yes "$digest_ref"');
    // Only images.yml from an images-v* tag is an accepted signer, not any workflow of the repo.
    const signer = String.raw`/\.github/workflows/images\.yml@refs/tags/images-v`;
    expect(verified).toContain(signer);
    expect(read('.github/workflows/images.yml')).toContain(signer);
  });

  it('scans, describes and checks the provenance of every platform it builds', () => {
    const script = read('infra/release/build-and-push.sh');
    expect(script).toContain('for platform in $platforms; do');
    expect(script).toContain('syft --platform "$platform" "$digest_ref"');
    expect(script).toContain('sh infra/release/trivy-gate.sh --platform "$platform" "$digest_ref"');
    expect(script).toContain('(index .Provenance \\"$platform\\").SLSA');
    expect(script).toContain('check-provenance.mjs "$provenance"');
    expect(script).not.toContain('"linux/amd64").SLSA');
    expect(script).toContain('--provenance=mode=max,version=v0.2');
  });

  it('pushes by digest, gates the digest, and tags only after every image passed', () => {
    const script = read('infra/release/build-and-push.sh');
    expect(script).toContain('push-by-digest=true,name-canonical=true,push=true');
    expect(script).not.toMatch(/--push\b/u);
    expect(script).not.toMatch(/^\s+--tag /mu);
    const lastGate = script.lastIndexOf('verify_published "$digest_ref"');
    const tagLoop = script.indexOf('docker buildx imagetools create --tag "$tagged" "$digest_ref"');
    const buildLoop = script.indexOf('done 3< "$plan"', script.indexOf('publish "$name"'));
    expect(lastGate).toBeGreaterThan(0);
    expect(buildLoop).toBeGreaterThan(lastGate);
    expect(tagLoop).toBeGreaterThan(buildLoop);
    // The tag must name the digest that passed.
    expect(script.slice(tagLoop)).toContain('node infra/release/resolve-digest.mjs "$tagged"');
  });

  it('never moves a published tag: it probes every tag first, and keeps only its own revision', () => {
    const script = read('infra/release/build-and-push.sh');
    const probe = script.indexOf(
      'if published="$(node infra/release/resolve-digest.mjs "$tagged")"',
    );
    expect(probe).toBeGreaterThan(0);
    expect(probe).toBeLessThan(script.indexOf('publish() {'));
    expect(script).toContain('node infra/release/image-revision.mjs "$published"');
    expect(script).toContain('[ "$published_revision" != "$revision" ]');
    expect(script).toContain('--label "$revision_label"');
    expect(read('infra/release/resolve-digest.mjs')).toContain('ABSENT.test(reason) ? 3');
  });

  it('reads the revision an image index carries', () => {
    const label = (revision?: string) => ({
      config: { Labels: revision ? { 'org.opencontainers.image.revision': revision } : {} },
    });
    expect(imageRevision({ 'linux/amd64': label('abc'), 'linux/arm64': label('abc') })).toBe('abc');
    expect(imageRevision(label('abc'))).toBe('abc');
    expect(imageRevision({ 'linux/amd64': label('abc'), 'linux/arm64': label('def') })).toBeNull();
    expect(imageRevision({ 'linux/amd64': label() })).toBeNull();
    expect(imageRevision(null)).toBeNull();
  });

  it.each([
    [['--dry-run', '--platform', 'linux/amd64'], /pass --security skip/u],
    [['--image', 'web', '--security', 'skip'], /only a --dry-run may build/u],
    [
      ['--dry-run', '--security', 'skip', '--image', 'nope'],
      /--image nope is not in the release plan/u,
    ],
  ])('refuses %j', (args, message) => {
    const result = spawnSync(shell, ['infra/release/build-and-push.sh', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, REGISTRY: 'example.invalid' },
    });
    if (result.error) throw result.error;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
  });
});

describe('the release trivy gate (#373, docs/adr/0087)', () => {
  const gate = read('infra/release/trivy-gate.sh');
  const ci = read('.github/workflows/ci.yml');

  it('writes the gate flags in one script, and both callers run that script', () => {
    for (const flag of [
      '--exit-code 1',
      '--severity HIGH,CRITICAL',
      '--ignore-unfixed',
      '--ignorefile "$root/.trivyignore.yaml"',
    ]) {
      expect(gate).toContain(flag);
    }
    for (const caller of ['infra/release/build-and-push.sh', 'infra/release/scan-images.sh']) {
      const script = read(caller);
      expect(script).toContain('sh infra/release/trivy-gate.sh --platform "$platform"');
      // No caller runs trivy with flags of its own.
      expect(script).not.toMatch(/^\s*trivy image/mu);
    }
  });

  it('scans every image of the release plan in a required pull-request job', () => {
    expect(read('infra/release/scan-images.sh')).toContain('node infra/release/images.mjs');
    const job = ci.slice(ci.indexOf('\n  image-scan:\n'), ci.indexOf('\n  full-e2e:\n'));
    expect(job).toContain('run: sh infra/release/scan-images.sh --platform linux/amd64');
    expect(ci).toMatch(/\n {4}needs:\s*\[[^\]]*\bimage-scan,[^\]]*\]\n {4}runs-on:/u);
  });

  it('records a build failure and still builds and scans every other image', () => {
    // Stand-ins for docker and trivy: the gateway build fails, everything else builds and passes.
    const bin = mkdtempSync(path.join(tmpdir(), 'aw-scan-images-'));
    temporary.push(bin);
    writeFileSync(
      path.join(bin, 'docker'),
      '#!/bin/sh\ncase "$*" in *agent-workspace-scan/gateway:local*) exit 1 ;; esac\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(path.join(bin, 'trivy'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = spawnSync(shell, ['infra/release/scan-images.sh'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: [bin, process.env['PATH']].join(path.delimiter) },
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::gateway did not build, so it could not be scanned');
    expect(result.stderr).toContain('images that did not build or failed the trivy gate: gateway');
    const scanned = releasePlan().filter((image) => image.name !== 'gateway');
    expect(scanned.length).toBe(8);
    for (const image of scanned) expect(result.stdout).toContain(`passed: ${image.name}\n`);
    // Nine images through a POSIX shell: slower than the default 5 s on a Windows host.
  }, 60_000);

  it("tags each invocation uniquely, so concurrent jobs on one daemon never remove each other's image", () => {
    // Stand-ins for docker and trivy that log every docker call.
    const bin = mkdtempSync(path.join(tmpdir(), 'aw-scan-images-'));
    temporary.push(bin);
    const calls = path.join(bin, 'calls.log');
    writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$*" >> '${calls}'\nexit 0\n`, {
      mode: 0o755,
    });
    writeFileSync(path.join(bin, 'trivy'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const run = () => {
      const result = spawnSync(shell, ['infra/release/scan-images.sh', '--image', 'gateway'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: [bin, process.env['PATH']].join(path.delimiter) },
      });
      if (result.error) throw result.error;
      expect(result.status).toBe(0);
    };
    run();
    run();
    const log = readFileSync(calls, 'utf8');
    const built = [...log.matchAll(/--tag (\S+)/gu)].map((match) => match[1]);
    const removed = [...log.matchAll(/^image rm (\S+)$/gmu)].map((match) => match[1]);
    expect(built).toHaveLength(2);
    expect(built[0]).toMatch(/^agent-workspace-scan\/gateway:local-[A-Za-z0-9]+$/u);
    expect(built[0]).not.toBe(built[1]);
    // Each invocation removes exactly the image it built.
    expect(removed).toEqual(built);
  }, 60_000);

  it('builds with the packageManager pnpm, and keeps npm and corepack out of every final stage', () => {
    const packageManager = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(
      (JSON.parse(read('package.json')) as { packageManager: string }).packageManager,
    )?.[1];
    expect(packageManager).toBeDefined();
    for (const dockerfile of [
      'Dockerfile',
      'gateway.Dockerfile',
      'egress-proxy.Dockerfile',
      'tool-host.Dockerfile',
      'runtime.Dockerfile',
    ]) {
      const source = read(dockerfile);
      expect(source).toContain(`corepack prepare pnpm@${packageManager!} --activate`);
      expect(source).not.toMatch(/^RUN pnpm prune/mu);
      // Every final stage deletes npm, npx and corepack.
      expect(source).toContain(
        'rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack',
      );
    }
    // The stages that launch connectors serve npx through pnpm dlx, with the same patched pnpm,
    // installed from its registry tarball rather than through npm or corepack (ADR-0087 D1).
    for (const dockerfile of ['Dockerfile', 'runtime.Dockerfile']) {
      const source = read(dockerfile);
      expect(source).toContain(`ARG PNPM_VERSION=${packageManager!}\n`);
      expect(source).toMatch(/^ARG PNPM_TARBALL_SHA256=[0-9a-f]{64}$/mu);
      expect(source).toContain('ADD --checksum=sha256:${PNPM_TARBALL_SHA256}');
      expect(source).toContain('COPY infra/images/npx.mjs infra/images/npx-run-bin.mjs /opt/npx/');
      expect(source).toContain('ENV PNPM_CLI=/opt/pnpm/bin/pnpm.cjs');
    }
    expect(read('gateway.Dockerfile')).not.toContain('npx.mjs');
    const [major, minor] = packageManager!.split('.').map(Number);
    // CVE-2026-82392 and CVE-2026-82393 are fixed in pnpm 11.11.0.
    expect(major! > 11 || (major === 11 && minor! >= 11)).toBe(true);
  });

  it('builds the engine port before core in the gateway image, which core imports', () => {
    const source = read('gateway.Dockerfile');
    expect(source).toContain('COPY packages/engine packages/engine\n');
    expect(source).toMatch(
      /COPY packages\/engine\/package\.json packages\/engine\/tsconfig\.json packages\/engine\/tsconfig\.build\.json /u,
    );
    const engine = source.indexOf('pnpm --filter @agent-workspace/engine build');
    expect(engine).toBeGreaterThan(-1);
    expect(engine).toBeLessThan(source.indexOf('pnpm --filter @agent-workspace/core build'));
  });

  it('runs the trivy version the release runs', () => {
    const version =
      /aquasecurity\/setup-trivy@[0-9a-f]{40} # v\S+\n(?: {8}if: .+\n)? {8}with:\n {10}version: (v\S+)\n/u;
    const released = version.exec(read('.github/workflows/images.yml'))?.[1];
    expect(released).toMatch(/^v\d+\.\d+\.\d+$/u);
    expect(version.exec(ci)?.[1]).toBe(released);
  });

  it('keeps each exception narrow, explained and expiring', () => {
    const ignore = read('.trivyignore.yaml');
    const entries = ignore.split(/^ {2}- id: /mu).slice(1);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toMatch(/^ {4}paths:\n {6}- /mu);
      expect(entry).toMatch(/^ {4}statement: \S/mu);
      const expiry = /^ {4}expired_at: (\d{4}-\d{2}-\d{2})$/mu.exec(entry)?.[1];
      expect(expiry).toBeDefined();
      // An exception is re-decided within a year; an entry dated further out is a permanent one.
      const days = (Date.parse(expiry!) - Date.parse('2026-09-30')) / 86_400_000;
      expect(days).toBeGreaterThan(0);
      expect(days).toBeLessThanOrEqual(366);
    }
  });

  it.each([
    [[], /usage: trivy-gate.sh/u],
    [['image:tag'], /--platform is required/u],
    [['--platform', 'linux/amd64;x', 'image:tag'], /unsafe characters/u],
  ])('refuses %j', (args, message) => {
    const result = spawnSync(shell, ['infra/release/trivy-gate.sh', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
  });
});

describe('the image release workflow', () => {
  const workflow = read('.github/workflows/images.yml');

  it('runs only from an images-v tag on main that names the pinned version', () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}tags: \['images-v\*'\]\n/mu);
    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    // persist-credentials: false leaves no token for a later fetch of an internal repository;
    // fetch-depth: 0 already brought origin/main.
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).not.toMatch(/git fetch/u);
    expect(workflow).toContain('"images-v$version"');
    expect(workflow).toContain('node infra/release/images.mjs --version');
  });

  it('publishes multi-arch through the release script, with least privilege and no stored secret', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/mu);
    expect(workflow).toContain('sh infra/release/build-and-push.sh --tag "$VERSION"');
    expect(workflow).not.toContain('--security skip');
    expect(workflow).toContain('platforms: arm64');
    expect(workflow).not.toMatch(/secrets\./u);
    expect(workflow).toMatch(/packages: write/u);
    expect(workflow).toMatch(/id-token: write/u);
    expect(workflow).toMatch(/^ {4}environment: images-publish$/mu);
  });

  it('pins buildx and BuildKit', () => {
    expect(workflow).toMatch(
      /setup-buildx-action@[0-9a-f]{40} # v\S+\n(?: {8}if: .+\n)? {8}with:\n {10}version: v\d+\.\d+\.\d+\n/u,
    );
    expect(workflow).toMatch(/driver-opts: image=moby\/buildkit:v[\d.]+@sha256:[0-9a-f]{64}/u);
  });

  it('uploads the manifest, then proves an anonymous pull of every digest in it', () => {
    expect(workflow).toContain('name: platform-images-${{ steps.version.outputs.version }}');
    const verify = workflow.slice(workflow.indexOf('  verify-public:'));
    expect(verify).toContain('docker logout ghcr.io');
    expect(verify).toContain('docker buildx imagetools inspect "$reference"');
    expect(verify).toContain('Change visibility, Public');
    expect(verify).not.toMatch(/packages: write|docker login/u);
  });
});

describe('release helpers', () => {
  it('signs provenance only when BuildKit recorded one', () => {
    expect(isSlsaProvenance(null)).toBe(false);
    expect(isSlsaProvenance({ builder: { id: '' } })).toBe(false);
    expect(
      isSlsaProvenance({ builder: { id: 'x' }, buildType: 'https://mobyproject.org/buildkit@v1' }),
    ).toBe(true);
  });

  it('runs the generator smoke only when every pinned image is published, and skips otherwise', () => {
    expect(smokeDecision(['published', 'published', 'published', 'published'])).toBe('run');
    expect(smokeDecision(['not-public', 'not-public', 'not-public', 'not-public'])).toBe('skip');
    expect(smokeDecision(['published', 'unpublished', 'published', 'published'])).toBe('skip');
    expect(smokeDecision(['published', 'unreachable', 'published', 'published'])).toBe('skip');
    expect(smokeDecision(['not-found'])).toBe('skip');
    expect(smokeDecision([])).toBe('fail');
  });

  it('reads a registry bearer challenge', () => {
    expect(
      bearerChallenge(
        'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"',
      ),
    ).toEqual({ realm: 'https://ghcr.io/token', service: 'ghcr.io', scope: 'repository:x:pull' });
  });
});

describe('the generator smoke registry probe', () => {
  const noWait = { sleep: () => Promise.resolve() };
  const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    new Response(status >= 300 ? null : JSON.stringify(body), { status, headers });
  /** A fake registry: each request takes the next answer, a response or an error to throw. */
  const scripted = (...answers: (Response | Error)[]) =>
    vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const next = answers.shift();
      if (next === undefined) return Promise.reject(new Error('unexpected request'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    });

  it('retries a network error, 429 and 5xx, then succeeds', async () => {
    const fetch = scripted(new TypeError('fetch failed'), answer(503), answer(200));
    const response = await fetchWithRetry('https://ghcr.io/v2/', {}, { fetch, ...noWait });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last attempt', async () => {
    const fetch = scripted(answer(429), answer(502), answer(500));
    await expect(fetchWithRetry('https://ghcr.io/v2/', {}, { fetch, ...noWait })).rejects.toThrow(
      RegistryUnreachable,
    );
    expect(fetch).toHaveBeenCalledTimes(ATTEMPTS);
  });

  it('does not retry a 4xx answer', async () => {
    const fetch = scripted(answer(404));
    const response = await fetchWithRetry('https://ghcr.io/v2/', {}, { fetch, ...noWait });
    expect(response.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  const challenge = {
    'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
  };
  const cases: [string, () => (Response | Error)[]][] = [
    ['published', () => [answer(401, {}, challenge), answer(200, { token: 't' }), answer(200)]],
    ['not-public', () => [answer(401, {}, challenge), answer(403)]],
    [
      'unpublished',
      () => [answer(401, {}, challenge), answer(200, { token: 't' }), answer(404), answer(200)],
    ],
    [
      'not-found',
      () => [answer(401, {}, challenge), answer(200, { token: 't' }), answer(404), answer(404)],
    ],
    ['unreachable', () => [new TypeError('fetch failed'), answer(503), answer(503)]],
  ];
  it.each(cases)('reads %s', async (state, answers) => {
    const probe = await probeImage('ghcr.io', 'example/agent-workspace/web', '1.0.0', {
      fetch: scripted(...answers()),
      ...noWait,
    });
    expect(probe.state).toBe(state);
  });

  it('calls a registry owner missing only on a definite 404', async () => {
    const exists = (...answers: (Response | Error)[]) =>
      githubOwnerExists('example', { fetch: scripted(...answers), ...noWait });
    expect(await exists(answer(404))).toBe(false);
    expect(await exists(answer(200))).toBe(true);
    expect(await exists(answer(403))).toBe(true);
    expect(await exists(answer(503), answer(503), answer(503))).toBe(true);
  });
});
