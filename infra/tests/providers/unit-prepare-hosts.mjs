import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { prepare } from './prepare.mjs';
import {
  cloudflareEnv,
  DIGEST,
  fakeDeps,
  KEY,
  TAG,
  vercelEnv,
} from './unit-prepare.test-support.mjs';

function vercelRun({ cached }) {
  return (command, args) => {
    if (args[0] === 'buildx' && args[1] === 'imagetools') {
      if (!cached)
        throw new Error('docker buildx imagetools inspect failed with exit 1: not found');
      return JSON.stringify({ digest: DIGEST });
    }
    if (args[0] === 'buildx' && args[1] === 'build') {
      writeFileSync(
        args[args.indexOf('--metadata-file') + 1],
        JSON.stringify({ 'containerimage.digest': DIGEST }),
      );
    }
    return '';
  };
}

function vercelRespond({
  projectStatus = 200,
  project = { id: 'prj_derived', name: 'aw-providers-live' },
  notReady = 1,
} = {}) {
  let pending = notReady;
  return (call) => {
    if (call.startsWith('GET /v9/projects/'))
      return [projectStatus, projectStatus === 200 ? project : undefined];
    if (call === 'POST /v11/projects')
      return [200, { id: 'prj_created', name: 'aw-providers-live' }];
    if (call.startsWith('GET /v2/teams/')) return [200, { slug: 'team-slug' }];
    if (call === 'POST /v4/sandboxes') {
      if (pending > 0) {
        pending -= 1;
        return [400, { error: { code: 'image_not_ready' } }];
      }
      return [201, {}];
    }
    if (call.startsWith('DELETE /v2/sandboxes/')) return [200, {}];
    return [500, undefined];
  };
}

test('vercel resolves the project by its fixed name, pins the pushed image and waits until VCR is ready', async () => {
  const deps = fakeDeps({ respond: vercelRespond(), run: vercelRun({ cached: true }) });
  const result = await prepare('vercel', vercelEnv, [KEY], deps);
  assert.deepEqual(result, {
    env: {
      VERCEL_PROJECT_ID: 'prj_derived',
      VERCEL_PROBE_IMAGE: `team-slug/aw-providers-live/aw-providers-probe@${DIGEST}`,
    },
  });
  const sandboxCalls = deps.calls.fetch.filter((call) => call.includes('sandboxes'));
  assert.deepEqual(sandboxCalls.slice(0, 2), ['POST /v4/sandboxes', 'POST /v4/sandboxes']);
  assert.equal(sandboxCalls.length, 3);
  assert.match(sandboxCalls[2], /^DELETE \/v2\/sandboxes\/aw-ready-/u);
  assert.ok(
    !deps.calls.run.some((call) => call.args[1] === 'build'),
    'a cached tag is not rebuilt',
  );
  const login = deps.calls.run.find((call) => call.args[0] === 'login');
  assert.equal(login.options.input, KEY);
  assert.ok(
    !JSON.stringify(deps.calls.run.map(({ args }) => args)).includes(KEY),
    'the token never reaches argv',
  );
});

test('vercel creates the missing project and builds the image when its tag is not in VCR', async () => {
  const deps = fakeDeps({
    respond: vercelRespond({ projectStatus: 404, notReady: 0 }),
    run: vercelRun({ cached: false }),
  });
  const result = await prepare('vercel', vercelEnv, [KEY], deps);
  assert.equal(result.env.VERCEL_PROJECT_ID, 'prj_created');
  assert.ok(deps.calls.fetch.includes('POST /v11/projects'));
  const build = deps.calls.run.find((call) => call.args[1] === 'build');
  assert.ok(build.args.includes('linux/amd64'));
  assert.ok(
    build.args.includes('--provenance=false') && build.args.includes('--sbom=false'),
    'a single-platform manifest is pushed',
  );
  const { DOCKER_CONFIG: credentials, BUILDX_CONFIG: builders } = build.options.env;
  assert.ok(
    typeof builders === 'string' && !path.resolve(builders).startsWith(path.resolve(credentials)),
    'buildx keeps the builder setup-buildx-action registered',
  );
  assert.match(
    build.args[build.args.indexOf('--output') + 1],
    /^type=image,name=vcr\.vercel\.com\/team-slug\/aw-providers-live\/aw-providers-probe:p-[0-9a-f]{16},push=true/u,
  );
});

test('a VERCEL_PROJECT_ID override is looked up, never created, and names the image repository', async () => {
  const found = fakeDeps({
    respond: vercelRespond({ project: { id: 'prj_custom', name: 'custom-name' }, notReady: 0 }),
    run: vercelRun({ cached: true }),
  });
  const result = await prepare(
    'vercel',
    { ...vercelEnv, VERCEL_PROJECT_ID: 'prj_custom' },
    [KEY],
    found,
  );
  assert.equal(result.env.VERCEL_PROJECT_ID, 'prj_custom');
  assert.match(result.env.VERCEL_PROBE_IMAGE, /^team-slug\/custom-name\//u);

  const missing = fakeDeps({ respond: vercelRespond({ projectStatus: 404 }) });
  const failure = await prepare(
    'vercel',
    { ...vercelEnv, VERCEL_PROJECT_ID: 'prj_gone' },
    [KEY],
    missing,
  );
  assert.equal(failure.failure, 'vercel project resolve failed with status 404');
  assert.ok(!missing.calls.fetch.includes('POST /v11/projects'));
});

test('vercel fails with the reason when the image never becomes ready or the push fails', async () => {
  let clock = 0;
  const never = fakeDeps({
    respond: vercelRespond({ notReady: Infinity }),
    run: vercelRun({ cached: true }),
    now: () => (clock += 200_000),
  });
  assert.equal(
    (await prepare('vercel', vercelEnv, [KEY], never)).failure,
    'vercel image readiness failed with status 400',
  );

  const push = fakeDeps({
    respond: vercelRespond(),
    run: (command, args) => {
      if (args[0] === 'login') return '';
      if (args[1] === 'imagetools') throw new Error('not found');
      throw new Error(`docker buildx build failed with exit 1: denied ${KEY}`);
    },
  });
  const failure = await prepare('vercel', vercelEnv, [KEY], push);
  assert.match(failure.failure, /^docker buildx build failed with exit 1: denied \[redacted\]$/u);
});

test('cloudflare pushes with wrangler and pins the digest docker reports for the registry name', async () => {
  const reference = `registry.cloudflare.com/acct0123/aw-providers-probe:${TAG}@${DIGEST}`;
  const deps = fakeDeps({
    run: (command) => (command === 'docker' ? `other.example/x@${DIGEST}\n${reference}\n` : ''),
  });
  assert.deepEqual(await prepare('cloudflare', cloudflareEnv, [KEY], deps), {
    env: { CLOUDFLARE_PROBE_IMAGE: reference },
  });
  const [build] = deps.calls.run;
  assert.deepEqual(build.args.slice(0, 5), [
    '--yes',
    'wrangler@4.147.0',
    'containers',
    'build',
    '-p',
  ]);
  assert.equal(build.args[build.args.indexOf('-t') + 1], `aw-providers-probe:${TAG}`);
  assert.ok(!JSON.stringify(deps.calls.run.map(({ args }) => args)).includes(KEY));
});

test('cloudflare fails when wrangler fails or no registry digest can be read back', async () => {
  const broken = fakeDeps({
    run: () => {
      throw new Error(`wrangler containers build failed with exit 1: ${KEY}`);
    },
  });
  assert.equal(
    (await prepare('cloudflare', cloudflareEnv, [KEY], broken)).failure,
    'wrangler containers build failed with exit 1: [redacted]',
  );
  const unreadable = fakeDeps({ run: () => '' });
  assert.match(
    (await prepare('cloudflare', cloudflareEnv, [KEY], unreadable)).failure,
    /neither docker nor the registry reports its digest/u,
  );
  const denied = fakeDeps({
    run: (command, args) => {
      if (command === 'npx') return '';
      throw new Error(
        `docker ${args[0] === 'image' ? 'image' : 'buildx imagetools'} inspect failed with exit 1: denied ${KEY}`,
      );
    },
  });
  assert.equal(
    (await prepare('cloudflare', cloudflareEnv, [KEY], denied)).failure,
    'wrangler pushed the image but neither docker nor the registry reports its digest: docker buildx imagetools inspect failed with exit 1: denied [redacted]',
  );
  const malformed = fakeDeps({
    run: (command, args) =>
      command === 'docker' && args[1] === 'imagetools'
        ? JSON.stringify({ digest: 'sha256:short' })
        : '',
  });
  assert.match(
    (await prepare('cloudflare', cloudflareEnv, [KEY], malformed)).failure,
    /neither docker nor the registry reports its digest/u,
  );
});

test('cloudflare reads the digest from the registry when wrangler skipped the push', async () => {
  // Wrangler found the image already in the registry: it removed its local tag and never added the
  // registry tag, so `docker image inspect` of the registry name fails (the daily lane, Nov 2026).
  const registryName = `registry.cloudflare.com/acct0123/aw-providers-probe:${TAG}`;
  const deps = fakeDeps({
    run: (command, args) => {
      if (command === 'npx') return 'Image already exists remotely, skipping push\n';
      if (args[0] === 'image')
        throw new Error(`docker image inspect failed with exit 1: No such image: ${registryName}`);
      if (args[1] === 'imagetools') {
        assert.equal(args[3], registryName);
        return JSON.stringify({
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: DIGEST,
          size: 1,
        });
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    },
  });
  assert.deepEqual(await prepare('cloudflare', cloudflareEnv, [KEY], deps), {
    env: {
      CLOUDFLARE_PROBE_IMAGE: `registry.cloudflare.com/acct0123/aw-providers-probe@${DIGEST}`,
    },
  });
  assert.deepEqual(
    deps.calls.run.map(({ command, args }) => `${command} ${args[0]} ${args[1]}`),
    ['npx --yes wrangler@4.147.0', 'docker image inspect', 'docker buildx imagetools'],
  );
});

test('cloudflare does not ask the registry when docker already reports the digest', async () => {
  const reference = `registry.cloudflare.com/acct0123/aw-providers-probe@${DIGEST}`;
  const deps = fakeDeps({
    run: (command, args) => (command === 'docker' && args[0] === 'image' ? `${reference}\n` : ''),
  });
  assert.equal(
    (await prepare('cloudflare', cloudflareEnv, [KEY], deps)).env.CLOUDFLARE_PROBE_IMAGE,
    reference,
  );
  assert.ok(!deps.calls.run.some(({ args }) => args[1] === 'imagetools'));
});
