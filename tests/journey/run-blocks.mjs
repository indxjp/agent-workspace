/**
 * The journey's order, and its blocks after the tools: B2 (look change), the ceiling and secret
 * checks, and J1 (the portal), after B1 (`run-basics.mjs`) and the tool blocks (`run-tools.mjs`).
 */
import { URL } from 'node:url';

import {
  JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  JOURNEY_PORTAL_BUDGET_SECONDS,
  JourneyFailure,
  assertSecretAbsent,
  assertServerRefusal,
  assertToolCallSeen,
  assertToolOffered,
  stubExpectation,
  withSurfaceColour,
} from './harness.mjs';
import { runFirstJourney, runRestartCheck, runUntimedChecks, timingsOf } from './run-basics.mjs';
import { startDev } from './run-dev.mjs';
import { PORTAL_FEATURES, portalTest, toolsTest } from './run-specs.mjs';
import { prepareOrdersSecret, runToolByHand, runToolFromSetup } from './run-tools.mjs';
import {
  CREATE_PACKAGE,
  DEMO_IN,
  DEMO_TOOLS_IN,
  HARNESS_IN,
  PID_FILE_IN,
  PORTAL_IN,
  WORK_IN,
  checksLimit,
  exec,
  execOk,
  nonce,
  readIn,
  say,
  scrub,
  uncapped,
  writeIn,
} from './run-support.mjs';
import { timedBlock } from './run-timing.mjs';

/** J1's one command: `docs/sdk/site/building/portal.mdx`'s, with the theme and the features. */
export const PORTAL_CREATE_ARGS = /** @type {const} */ ([
  'portal',
  '--',
  '--template',
  'portal',
  '--theme',
  'blank',
  '--features',
  PORTAL_FEATURES.join(','),
  '--yes',
]);
/** The cap on J1's untimed console check and the stop of its `aw dev` (`harness.test.ts`). */
export const PORTAL_CHECKS_MS = 5 * 60_000;

/** The colour B2 writes into `surfaces/main.ts`: neither the default nor B1's brand colour. */
const JOURNEY_COLOUR = '#16a085';
/** The ceiling the untimed check appends under the promotion bar's `policy` (C13). */
const CEILING_YAML = '  permissions:\n    runCommands: false\n';

/** @typedef {import('./run-basics.mjs').JourneyContext} JourneyContext */
/** @typedef {import('./run-tools.mjs').OrdersSecret} OrdersSecret */
/** @typedef {import('./run-tools.mjs').AgentFile} AgentFile */

/**
 * Every phase of the journey, in order; a failure stops the run where it happened.
 *
 * @param {JourneyContext} ctx
 */
export async function runJourney(ctx) {
  const { baseUrl, created } = await runFirstJourney(ctx);
  const { agent, limit } = await runUntimedChecks(ctx, baseUrl, created);
  const { second, again } = await runRestartCheck(ctx, agent, limit);

  // S2-08: B2, B3b and B3a, each on its own clock, in the same container after B1.
  const orders = prepareOrdersSecret(ctx);
  await runLookChange(ctx, new URL(again.ready).origin);
  await runToolByHand(ctx, orders, agent, second);
  await runToolFromSetup(ctx, orders);
  await runCeilingAndSecret(ctx, orders, agent);
  await runPortal(ctx);
  say('journey: every check passed');
}

/**
 * B2: the clock runs from the write of surfaces/main.ts to the launcher showing the colour.
 *
 * @param {JourneyContext} ctx @param {string} baseUrl
 */
async function runLookChange(ctx, baseUrl) {
  const { machine } = ctx;
  const surfaceFile = `${DEMO_IN}/surfaces/main.ts`;
  const surface = await readIn(machine, surfaceFile, 30_000);
  const block = {
    key: 'lookChange',
    label: 'B2 look change',
    budgetSeconds: JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  };
  await timedBlock(timingsOf(ctx), block, async (step, timeout) => {
    await step(`write ${JOURNEY_COLOUR} into surfaces/main.ts`, async () => {
      await writeIn(machine, surfaceFile, withSurfaceColour(surface, JOURNEY_COLOUR), timeout());
    });
    await step(`the launcher shows ${JOURNEY_COLOUR}`, async () => {
      await toolsTest(machine, {
        baseUrl,
        grep: 'look change',
        env: { JOURNEY_COLOUR },
        timeoutMs: timeout(),
      });
    });
  });
}

/**
 * The ceiling end to end (C13, C14), untimed, under a checks cap of its own: `aw dev` and `aw check`
 * print the server's refusal, and the agent saved before it still answers, with `Bash` denied.
 *
 * @param {JourneyContext} ctx @param {OrdersSecret} orders @param {AgentFile} agent
 * @param {(capMs: number) => number} limit
 */
async function checkCeiling(ctx, orders, agent, limit) {
  const { machine } = ctx;
  await execOk(machine, ['sh', '-c', 'cat >> agent-workspace.yaml'], {
    workdir: DEMO_IN,
    input: CEILING_YAML,
    timeoutMs: limit(30_000),
  });
  const dev = startDev(machine, DEMO_IN, orders.env);
  ctx.devs.push(dev);
  await dev.until(
    (current) => current.ready !== null && current.log.includes(' policy_cannot_widen'),
    () => (dev.state.ready === null ? 'ready' : 'policy_cannot_widen'),
    limit(240_000),
  );
  // The refused agent prints no surface line, so the origin comes from the ready screen's `try` row.
  const ready = dev.state.ready;
  if (ready === null) throw new JourneyFailure('npm run dev printed no ready line');
  assertServerRefusal(dev.state.log, agent.file);
  const check = await exec(machine, ['npx', 'aw', 'check'], {
    workdir: DEMO_IN,
    timeoutMs: limit(180_000),
  });
  if (check.status !== 1) {
    throw new JourneyFailure(`aw check under the ceiling exited ${String(check.status)}, not 1`);
  }
  assertServerRefusal(check.output, agent.file);
  // The agent saved before the ceiling still answers, composed with Bash denied (S2-04c).
  const ceilingNonce = nonce();
  await toolsTest(machine, {
    baseUrl: new URL(ready).origin,
    grep: 'tool answer',
    env: {
      JOURNEY_NONCE: ceilingNonce,
      ...stubExpectation(ctx.live, `order-data-${ceilingNonce}`),
    },
    timeoutMs: limit(300_000),
  });
  assertToolCallSeen(ctx.calls, ceilingNonce, orders.token);
  if (!ctx.live) assertToolOffered(ctx.toolRequests, ceilingNonce, 'Bash', false);
  say('journey: policy_cannot_widen reported by the server; sync refused; Bash denied at compose');
  return { dev, check };
}

/**
 * The secret: in no file but the sealed store, no log, no transcript, no request and not in the
 * environment of the runtime aw dev forked.
 *
 * @param {JourneyContext} ctx @param {OrdersSecret} orders
 * @param {string} checkOutput `aw check`'s output @param {(capMs: number) => number} limit
 */
async function checkTokenAbsent(ctx, orders, checkOutput, limit) {
  const { machine } = ctx;
  const found = await execOk(machine, ['node', HARNESS_IN, 'find', DEMO_IN, DEMO_TOOLS_IN], {
    env: { JOURNEY_SECRET: orders.token },
    timeoutMs: limit(120_000),
    quiet: true,
  });
  const holding = JSON.parse(found.stdout);
  if (!Array.isArray(holding) || holding.length > 0) {
    throw new JourneyFailure(`the token is in files: ${scrub(found.stdout.trim())}`);
  }
  /** @param {string} pidFile */
  const environOf = async (pidFile) =>
    (
      await execOk(
        machine,
        ['sh', '-c', 'tr "\\0" "\\n" < "/proc/$(cat "$1")/environ"', 'sh', pidFile],
        { workdir: DEMO_IN, timeoutMs: limit(30_000), quiet: true },
      )
    ).stdout;
  // Positive control: the process aw dev runs in was given the token, so the check can see it.
  if (!(await environOf(PID_FILE_IN)).includes(orders.token)) {
    throw new JourneyFailure('the environment check cannot see the token');
  }
  const runtimeEnviron = await environOf('.agent-workspace/runtime.pid');
  assertSecretAbsent(
    {
      ...Object.fromEntries(
        ctx.devs.map((dev, index) => [`dev-${String(index + 1)}.log`, dev.state.log]),
      ),
      'aw check output': checkOutput,
      "the runtime's environment": runtimeEnviron,
      'the model requests': ctx.bodies.join('\n'),
      'the recorded tool turns': JSON.stringify(ctx.toolRequests),
      'the recorded replies': JSON.stringify(ctx.requests),
    },
    orders.token,
  );
  say("journey: token absent from files, logs, transcripts and the runtime's environment");
}

/**
 * @param {JourneyContext} ctx @param {OrdersSecret} orders @param {AgentFile} agent
 */
async function runCeilingAndSecret(ctx, orders, agent) {
  const limit = checksLimit(Date.now() + ctx.checksMs);
  const { dev, check } = await checkCeiling(ctx, orders, agent, limit);
  await checkTokenAbsent(ctx, orders, check.output, limit);
  await dev.stop(limit);
}

/**
 * J1's `npm run dev` step: until the ready screen names the console and the app, the bootstrap
 * admin is signed in and the first sync is done.
 *
 * @param {JourneyContext} ctx @param {() => number} timeout
 */
async function startPortalDev(ctx, timeout) {
  const dev = startDev(ctx.machine, PORTAL_IN, ctx.anthropic);
  ctx.devs.push(dev);
  /** The line still missing, in the order the screen prints them. */
  const missing = () => {
    if (dev.state.console === null) return 'console';
    if (dev.state.app === null) return 'app';
    return dev.state.signedIn ? 'synced:' : 'signed in';
  };
  await dev.until(
    (current) =>
      current.console !== null && current.app !== null && current.signedIn && current.syncs > 0,
    missing,
    timeout(),
  );
  return dev;
}

/**
 * J1 (issue #1510): from the start of npm create --template portal to the first page of the portal
 * a person sees signed in, on its own clock; then, untimed, the console's features.
 *
 * @param {JourneyContext} ctx
 */
async function runPortal(ctx) {
  const { machine } = ctx;
  /** @type {ReturnType<typeof startDev> | undefined} */
  let portalDev;
  const block = { key: 'portal', label: 'J1 portal', budgetSeconds: JOURNEY_PORTAL_BUDGET_SECONDS };
  await timedBlock(timingsOf(ctx), block, async (step, timeout) => {
    await step(`npm create ${CREATE_PACKAGE} ${PORTAL_CREATE_ARGS.join(' ')}`, async () => {
      await execOk(machine, ['npm', 'create', CREATE_PACKAGE, ...PORTAL_CREATE_ARGS], {
        workdir: WORK_IN,
        timeoutMs: timeout(),
      });
    });
    await step('npm install', async () => {
      await execOk(machine, ['npm', 'install'], { workdir: PORTAL_IN, timeoutMs: timeout() });
    });
    await step('npm run dev', async () => {
      portalDev = await startPortalDev(ctx, timeout);
    });
    await step('the portal signs in', async () => {
      await portalTest(machine, portalDev, 'portal signs in', timeout());
    });
  });
  await portalTest(machine, portalDev, 'console shows only the chosen features', PORTAL_CHECKS_MS);
  if (portalDev === undefined) throw new JourneyFailure('no npm run dev to stop');
  await portalDev.stop(uncapped);
}
