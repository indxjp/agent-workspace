/**
 * S2-08's openapi tool blocks: B3b (the tool written by hand) and B3a (the tool from setup), each
 * on its own clock, and the orders API's token they both use.
 */
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';

import {
  JOURNEY_TOOL_BUDGET_SECONDS,
  JourneyFailure,
  assertToolAnswer,
  assertToolCallSeen,
  assertToolOffered,
  assertUnchanged,
  firstTokenOf,
  stubExpectation,
  toolAgentSource,
} from './harness.mjs';
import { timingsOf } from './run-basics.mjs';
import { evaluateAgainstStub } from './run-checks.mjs';
import { startDev } from './run-dev.mjs';
import { checkPromotionGate, toolsTest } from './run-specs.mjs';
import {
  CREATE_PACKAGE,
  DEMO_IN,
  DEMO_TOOLS_IN,
  SECRETS,
  WORK_IN,
  checksLimit,
  execAnswering,
  execOk,
  nonce,
  promptOf,
  say,
  snapshotDemo,
  uncapped,
  writeIn,
} from './run-support.mjs';
import { recordFirstToken, timedBlock } from './run-timing.mjs';

/** Where the developer puts the orders API's document, in both B3 projects. */
const ORDERS_DOCUMENT = 'apis/orders.openapi.json';
/** The variable `secret('ORDERS_TOKEN')` names: what setup derives from `orders.openapi.json`. */
const ORDERS_TOKEN_VARIABLE = 'ORDERS_TOKEN';
const ORDERS_TOKEN_PREFIX = 'orders-e2e-';
/** B3b's hand-written tool: the plan's form, allowing the one read operation it needs. */
const ORDERS_TOOL_SOURCE = [
  "import { openapiTool, secret } from '@indx-workspace/sdk/define';",
  '',
  'export default openapiTool({',
  "  name: 'orders',",
  `  spec: '${ORDERS_DOCUMENT}',`,
  `  auth: secret('${ORDERS_TOKEN_VARIABLE}'),`,
  "  allow: ['GET /orders/*'],",
  '});',
  '',
].join('\n');
/**
 * The promotion bar (issue #619) the journey appends to `agent-workspace.yaml` before B3b, so the
 * `aw dev` B3b restarts enforces it; `policy` is then the file's last mapping.
 */
const PROMOTION_BAR_YAML = 'policy:\n  promotion:\n    minEvalScore: 1\n';

/** @typedef {import('./run-basics.mjs').JourneyContext} JourneyContext */
/** @typedef {{ token: string, env: Record<string, string>, document: string }} OrdersSecret */
/** @typedef {{ file: string, source: string }} AgentFile */

/**
 * The orders API's token (passed to `aw dev` by name, like the fake key) and its OpenAPI document.
 *
 * @param {JourneyContext} ctx
 * @returns {OrdersSecret}
 */
export function prepareOrdersSecret(ctx) {
  const token = `${ORDERS_TOKEN_PREFIX}${randomBytes(16).toString('hex')}`;
  SECRETS.add(token);
  return {
    token,
    env: { [ORDERS_TOKEN_VARIABLE]: token },
    document: ctx.ordersApi.document(ctx.ordersOrigin),
  };
}

/**
 * A widget answer that calls the orders tool: the spec, the orders API's record of the call with
 * the token, (fake model only) the model's own record, and the first-token latency under `key`.
 *
 * @param {JourneyContext} ctx @param {OrdersSecret} orders
 * @param {{ ready: string | null, nonce: string, key: string, timeout: () => number }} answer
 */
async function expectToolAnswer(ctx, orders, answer) {
  if (answer.ready === null) throw new JourneyFailure('npm run dev printed no ready line');
  const output = await toolsTest(ctx.machine, {
    baseUrl: new URL(answer.ready).origin,
    grep: 'tool answer',
    env: {
      JOURNEY_NONCE: answer.nonce,
      ...stubExpectation(ctx.live, `order-data-${answer.nonce}`),
    },
    timeoutMs: answer.timeout(),
  });
  assertToolCallSeen(ctx.calls, answer.nonce, orders.token);
  if (!ctx.live) assertToolAnswer(ctx.requests, answer.nonce);
  recordFirstToken(timingsOf(ctx), answer.key, firstTokenOf(output));
}

/**
 * B3b's first step: the document, `tools/orders.ts` and the agent that uses it.
 *
 * @param {JourneyContext} ctx @param {OrdersSecret} orders @param {AgentFile} agent
 * @param {() => number} timeout
 */
async function writeOrdersTool(ctx, orders, agent, timeout) {
  const { machine } = ctx;
  await writeIn(machine, `${DEMO_IN}/${ORDERS_DOCUMENT}`, orders.document, timeout());
  await writeIn(machine, `${DEMO_IN}/tools/orders.ts`, ORDERS_TOOL_SOURCE, timeout());
  await writeIn(machine, `${DEMO_IN}/${agent.file}`, toolAgentSource(agent.source), timeout());
}

/**
 * B3b's second step: stop the running `aw dev` and start it with the token. The model connection
 * persists from B1, so only the token is passed.
 *
 * @param {JourneyContext} ctx @param {OrdersSecret} orders
 * @param {ReturnType<typeof startDev>} running @param {() => number} timeout
 */
async function restartWithToken(ctx, orders, running, timeout) {
  await running.stop((capMs) => Math.min(capMs, timeout()));
  const dev = startDev(ctx.machine, DEMO_IN, orders.env);
  ctx.devs.push(dev);
  await dev.until(
    (current) => current.ready !== null && current.syncs > 0,
    () => (dev.state.ready === null ? 'ready' : 'synced:'),
    timeout(),
  );
  return dev;
}

/**
 * Issue #618, stub model only: `aw eval` scores local's version on the server, then the promotion
 * gate (#619) blocks a failing case and lets the fix through.
 *
 * @param {JourneyContext} ctx @param {AgentFile} agent @param {string} toolNonce
 */
async function evaluateAndGate(ctx, agent, toolNonce) {
  const limit = checksLimit(Date.now() + ctx.checksMs);
  const { toolRequests } = ctx;
  await evaluateAgainstStub(ctx.machine, { agent, toolRequests, toolNonce, limit });
  await checkPromotionGate(ctx.machine, limit);
}

/**
 * B3b: from the write of tools/orders.ts to the answer, the stop and the restart included.
 *
 * @param {JourneyContext} ctx @param {OrdersSecret} orders @param {AgentFile} agent
 * @param {ReturnType<typeof startDev>} second the `aw dev` B1's restart check left running
 */
export async function runToolByHand(ctx, orders, agent, second) {
  // Issue #619: the bar B3b's restart picks up, untimed. No version is promoted before B3b's.
  await execOk(ctx.machine, ['sh', '-c', 'cat >> agent-workspace.yaml'], {
    workdir: DEMO_IN,
    input: PROMOTION_BAR_YAML,
    timeoutMs: 30_000,
  });
  /** @type {ReturnType<typeof startDev> | undefined} */
  let byHand;
  const byHandNonce = nonce();
  const block = {
    key: 'toolByHand',
    label: 'B3b openapi tool by hand',
    budgetSeconds: JOURNEY_TOOL_BUDGET_SECONDS,
  };
  await timedBlock(timingsOf(ctx), block, async (step, timeout) => {
    await step('write the document, tools/orders.ts and the agent', () =>
      writeOrdersTool(ctx, orders, agent, timeout),
    );
    await step(`restart aw dev with ${ORDERS_TOKEN_VARIABLE}`, async () => {
      byHand = await restartWithToken(ctx, orders, second, timeout);
    });
    await step('the widget answers with the tool', () =>
      expectToolAnswer(ctx, orders, {
        ready: byHand?.state.ready ?? null,
        nonce: byHandNonce,
        key: 'toolByHand',
        timeout,
      }),
    );
  });
  say(`journey: tool call GET /orders/${byHandNonce} seen`);
  if (!ctx.live) {
    // The baseline the ceiling check falsifies: before the ceiling, the agent's Bash is offered.
    assertToolOffered(ctx.toolRequests, byHandNonce, 'Bash', true);
    // Stub only: a live model's answers are not deterministic.
    await evaluateAndGate(ctx, agent, byHandNonce);
  }
  if (byHand === undefined) throw new JourneyFailure('no npm run dev to stop');
  await byHand.stop(uncapped);
}

/**
 * B3a's project: `npm create` answering `openapi` and the document's path, then the developer's
 * one input, the document, `npm install` and `npm run dev` with the token.
 *
 * @param {JourneyContext} ctx @param {OrdersSecret} orders
 * @param {(name: string, run: () => Promise<void>) => Promise<void>} step @param {() => number} timeout
 */
async function setUpToolsProject(ctx, orders, step, timeout) {
  const { machine } = ctx;
  await step(
    `npm create @indx-workspace@latest demo-tools (openapi, ${ORDERS_DOCUMENT})`,
    async () => {
      await execAnswering(machine, `npm create ${CREATE_PACKAGE} demo-tools`, {
        workdir: WORK_IN,
        timeoutMs: timeout(),
        answers: {
          [promptOf('content.internalTools')]: 'openapi',
          [promptOf('content.openapiDocument')]: ORDERS_DOCUMENT,
        },
      });
    },
  );
  const createdTools = await snapshotDemo(machine, timeout(), DEMO_TOOLS_IN);
  await step(`copy the orders API's document to ${ORDERS_DOCUMENT}`, async () => {
    // ponytail: document written via cat over exec input; the developer's input, not an edit
    await writeIn(machine, `${DEMO_TOOLS_IN}/${ORDERS_DOCUMENT}`, orders.document, timeout());
  });
  await step('npm install', async () => {
    await execOk(machine, ['npm', 'install'], { workdir: DEMO_TOOLS_IN, timeoutMs: timeout() });
  });
  await step('npm run dev', async () => {
    const dev = startDev(machine, DEMO_TOOLS_IN, { ...ctx.anthropic, ...orders.env });
    ctx.devs.push(dev);
    await dev.untilWidget(timeout());
  });
  return createdTools;
}

/**
 * B3a: from the start of npm create to the answer, with no file edited by hand.
 *
 * @param {JourneyContext} ctx @param {OrdersSecret} orders
 */
export async function runToolFromSetup(ctx, orders) {
  /** @type {Record<string, string>} */
  let createdTools = {};
  const fromSetupNonce = nonce();
  const block = {
    key: 'toolFromSetup',
    label: 'B3a openapi tool from setup',
    budgetSeconds: JOURNEY_TOOL_BUDGET_SECONDS,
  };
  await timedBlock(timingsOf(ctx), block, async (step, timeout) => {
    createdTools = await setUpToolsProject(ctx, orders, step, timeout);
    await step('the widget answers with the tool', () =>
      expectToolAnswer(ctx, orders, {
        ready: ctx.devs.at(-1)?.state.ready ?? null,
        nonce: fromSetupNonce,
        key: 'toolFromSetup',
        timeout,
      }),
    );
  });
  say(`journey: tool call GET /orders/${fromSetupNonce} seen`);
  if (!Object.hasOwn(createdTools, 'tools/orders.ts')) {
    throw new JourneyFailure('npm create wrote no tools/orders.ts for the openapi answer');
  }
  assertUnchanged(
    'demo-tools',
    createdTools,
    await snapshotDemo(ctx.machine, 120_000, DEMO_TOOLS_IN),
    [ORDERS_DOCUMENT],
  );
  say(`journey: B3a files written: ${Object.keys(createdTools).sort().join(', ')}; none edited`);
  const fromSetup = ctx.devs.at(-1);
  if (fromSetup === undefined) throw new JourneyFailure('no npm run dev to stop');
  await fromSetup.stop(uncapped);
}
