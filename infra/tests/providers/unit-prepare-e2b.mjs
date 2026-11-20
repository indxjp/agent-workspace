import assert from 'node:assert/strict';
import test from 'node:test';

import { renderSummary } from '../isolation/summary.mjs';
import { e2bBuild, inlineBaseImage, prepare, probeKey, readProbeFiles } from './prepare.mjs';
import { CHECKS, failedRows } from './support.mjs';
import {
  BUILD_ID,
  cloudflareEnv,
  e2bEnv,
  fakeDeps,
  KEY,
  probeFiles,
  TAG,
  vercelEnv,
} from './unit-prepare.test-support.mjs';

test('the probe key follows the content of the two probe files and nothing else', async () => {
  assert.match(TAG, /^p-[0-9a-f]{16}$/u);
  assert.equal(probeKey(probeFiles), probeKey({ ...probeFiles }));
  assert.notEqual(probeKey(probeFiles), probeKey({ ...probeFiles, probe: 'probe2' }));
  assert.notEqual(
    probeKey(probeFiles),
    probeKey({ ...probeFiles, dockerfile: `${probeFiles.dockerfile}\n` }),
  );
  const real = await readProbeFiles();
  assert.match(probeKey(real), /^[0-9a-f]{16}$/u);
  const inlined = inlineBaseImage(real.dockerfile);
  assert.doesNotMatch(inlined, /ARG NODE_IMAGE|\$\{NODE_IMAGE\}/u);
  assert.match(inlined, /^FROM node:\S+@sha256:[0-9a-f]{64}$/mu);
});

test('an override variable is used as is and nothing is called', async () => {
  const overrides = {
    e2b: { ...e2bEnv, E2B_PROBE_TEMPLATE: 'custom:tpl' },
    vercel: {
      ...vercelEnv,
      VERCEL_PROJECT_ID: 'prj_custom',
      VERCEL_PROBE_IMAGE: 'custom/image@sha256:aa',
    },
    cloudflare: { ...cloudflareEnv, CLOUDFLARE_PROBE_IMAGE: 'registry.example/x@sha256:bb' },
  };
  for (const [lane, env] of Object.entries(overrides)) {
    const deps = fakeDeps();
    const result = await prepare(lane, env, [KEY], deps);
    const expected = Object.fromEntries(
      Object.entries(env).filter(([name]) => /PROBE|PROJECT_ID/u.test(name)),
    );
    assert.deepEqual(result, { env: expected }, lane);
    assert.deepEqual(deps.calls, { fetch: [], run: [] }, lane);
  }
});

test('an empty override variable counts as unset', async () => {
  const deps = fakeDeps({ respond: () => [200, [{ tag: TAG, buildID: BUILD_ID }]] });
  const result = await prepare('e2b', { ...e2bEnv, E2B_PROBE_TEMPLATE: '' }, [KEY], deps);
  assert.deepEqual(result, { env: { E2B_PROBE_TEMPLATE: `aw-providers-probe:${BUILD_ID}` } });
});

const TEMPLATE_ID = 'tpl0123';
const BUILD_STATUS = `GET /templates/${TEMPLATE_ID}/builds/${BUILD_ID}/status`;

/** E2B REST fakes: `lookups` answers the tag lookups in turn, the rest of the build by default succeeds. */
function e2bRespond({
  lookups = [[200, []]],
  create = [202, { templateID: TEMPLATE_ID, buildID: BUILD_ID }],
  ...overrides
} = {}) {
  const pending = [...lookups];
  let polls = 0;
  const answers = {
    'POST /v3/templates': create,
    [`POST /v2/templates/${TEMPLATE_ID}/builds/${BUILD_ID}`]: [202, {}],
    'POST /templates/tags': [201, { buildID: BUILD_ID, tags: [TAG] }],
    ...overrides,
  };
  return (call) => {
    if (call === 'GET /templates/aw-providers-probe/tags')
      return pending.length > 1 ? pending.shift() : pending[0];
    if (call === BUILD_STATUS && answers[BUILD_STATUS] === undefined) {
      polls += 1;
      return [200, { status: polls === 1 ? 'building' : 'ready' }];
    }
    return answers[call] ?? [500, undefined];
  };
}

test('e2b reuses the template tagged with the probe hash and builds nothing', async () => {
  const cached = fakeDeps({
    respond: () => [
      200,
      [
        { tag: 'default', buildID: 'x' },
        { tag: TAG, buildID: BUILD_ID },
      ],
    ],
  });
  assert.deepEqual(await prepare('e2b', e2bEnv, [KEY], cached), {
    env: { E2B_PROBE_TEMPLATE: `aw-providers-probe:${BUILD_ID}` },
  });
  assert.deepEqual(cached.calls.fetch, ['GET /templates/aw-providers-probe/tags']);
  assert.deepEqual(cached.calls.run, []);
});

test('e2b builds the template over REST when the tag is missing, then tags the build', async () => {
  for (const lookup of [
    [200, []],
    [404, undefined],
  ]) {
    const bodies = {};
    const respond = e2bRespond({ lookups: [lookup] });
    const built = fakeDeps({
      respond: (call, init) => {
        if (init.body !== undefined) bodies[call] = JSON.parse(init.body);
        return respond(call);
      },
    });
    assert.deepEqual(await prepare('e2b', e2bEnv, [KEY], built), {
      env: { E2B_PROBE_TEMPLATE: `aw-providers-probe:${BUILD_ID}` },
    });
    assert.deepEqual(built.calls.fetch, [
      'GET /templates/aw-providers-probe/tags',
      'POST /v3/templates',
      `POST /v2/templates/${TEMPLATE_ID}/builds/${BUILD_ID}`,
      BUILD_STATUS,
      BUILD_STATUS,
      'POST /templates/tags',
    ]);
    assert.deepEqual(built.calls.run, [], 'no CLI and no SDK');
    assert.deepEqual(bodies['POST /v3/templates'], { name: 'aw-providers-probe' });
    const build = bodies[`POST /v2/templates/${TEMPLATE_ID}/builds/${BUILD_ID}`];
    assert.equal(build.fromImage, 'node:1@sha256:00');
    assert.deepEqual(build.steps, [
      { type: 'USER', args: ['root'] },
      { type: 'USER', args: ['node'] },
    ]);
    assert.equal(
      'startCmd' in build,
      false,
      'the provider starts the probe after create, with the bearer',
    );
    assert.equal('readyCmd' in build, false);
    assert.deepEqual(bodies['POST /templates/tags'], {
      target: 'aw-providers-probe:default',
      tags: [TAG],
    });
  }
});

test('the e2b build mirrors probe.Dockerfile and writes probe.mjs from base64', async () => {
  const real = await readProbeFiles();
  const { steps } = e2bBuild(real);
  assert.deepEqual(
    steps.map(({ type }) => type),
    ['USER', 'RUN', 'RUN', 'USER', 'WORKDIR'],
  );
  const encoded =
    /^printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/srv\/apps\/runner\/dist\/index\.js$/u.exec(
      steps[2].args[0],
    );
  assert.equal(Buffer.from(encoded[1], 'base64').toString('utf8'), real.probe);
  assert.doesNotMatch(
    real.probe,
    /49983|\/envs/u,
    'the probe no longer reads the bearer from envd',
  );
});

test('e2b reuses the template when it already exists and another run tagged it', async () => {
  const deps = fakeDeps({
    respond: e2bRespond({
      lookups: [
        [200, []],
        [200, [{ tag: TAG, buildID: BUILD_ID }]],
      ],
      create: [409, undefined],
    }),
  });
  assert.deepEqual(await prepare('e2b', e2bEnv, [KEY], deps), {
    env: { E2B_PROBE_TEMPLATE: `aw-providers-probe:${BUILD_ID}` },
  });
  assert.deepEqual(deps.calls.fetch, [
    'GET /templates/aw-providers-probe/tags',
    'POST /v3/templates',
    'GET /templates/aw-providers-probe/tags',
  ]);
});

test('an e2b REST error is returned without provider text, and every row of the lane then reads fail', async () => {
  const cases = [
    [{ lookups: [[500, undefined]] }, 'e2b tag lookup failed with status 500'],
    [{ create: [409, undefined] }, 'e2b template create failed with status 409'],
    [{ create: [403, { message: `banned ${KEY}` }] }, 'e2b template create failed with status 403'],
    [{ create: [202, { templateID: TEMPLATE_ID }] }, 'e2b reported no build id'],
    [
      { [`POST /v2/templates/${TEMPLATE_ID}/builds/${BUILD_ID}`]: [400, { message: KEY }] },
      'e2b template build failed with status 400',
    ],
    [
      { [BUILD_STATUS]: [200, { status: 'error', reason: { message: KEY } }] },
      'e2b template build failed',
    ],
    [{ 'POST /templates/tags': [404, undefined] }, 'e2b tag assign failed with status 404'],
    [
      { 'POST /templates/tags': [201, { buildID: 'other' }] },
      'e2b tag assign did not tag this build',
    ],
  ];
  for (const [answers, expected] of cases) {
    const result = await prepare('e2b', e2bEnv, [KEY], fakeDeps({ respond: e2bRespond(answers) }));
    assert.equal(result.failure, expected);
  }
  let clock = 0;
  const stuck = fakeDeps({
    respond: e2bRespond({ [BUILD_STATUS]: [200, { status: 'building' }] }),
    now: () => (clock += 400_000),
  });
  assert.equal(
    (await prepare('e2b', e2bEnv, [KEY], stuck)).failure,
    'e2b template build timed out',
  );

  const transport = fakeDeps();
  transport.fetch = async () => {
    throw new Error(`connect failed ${KEY}`);
  };
  const failure = (await prepare('e2b', e2bEnv, [KEY], transport)).failure;
  assert.equal(failure, 'e2b tag lookup failed');

  const rows = failedRows('e2b template build failed with status 400');
  assert.deepEqual(Object.keys(rows).sort(), Object.keys(CHECKS).sort());
  for (const { outcome, detail } of Object.values(rows)) {
    assert.equal(outcome, 'fail');
    assert.match(detail, /^probe artefact: e2b template build failed/u);
  }
  const summary = renderSummary({ e2b: rows });
  assert.equal(summary.clean, false);
  assert.match(summary.markdown, /\| fail \|/u);
});
