/**
 * What `run.mjs` reads before any Docker work (the command line and the environment) and the model
 * provider it starts: the fake on the host's loopback, or the real API.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { positiveIntegerVariable } from '../generated-project/run.mjs';
import { journeyMode, registryOf, splitFirstHour, workDirectoryOf } from './harness.mjs';
import { serveOnLoopback, startFakeProvider } from './run-machine.mjs';
import {
  CHECKS_BUDGET_MS,
  CHECKS_VARIABLE,
  FAKE_KEY_PREFIX,
  PREPARE_BUDGET_MS,
  PREPARE_VARIABLE,
  SECRETS,
  say,
} from './run-support.mjs';

/** @typedef {ReturnType<typeof readRunOptions>} RunOptions */
/** @typedef {{ fake?: { close: () => void }, orders?: { close: () => void } }} LoopbackServers */

/**
 * What the command line and the environment say, read before any Docker work: `--live` without
 * its key stops here, naming the secret.
 */
export function readRunOptions() {
  // `--first-hour` (issue #700) runs only the first-hour stopwatch, in place of the journey.
  const { firstHour, rest } = splitFirstHour(process.argv.slice(2));
  const mode = journeyMode(rest, process.env);
  if (mode.live) SECRETS.add(mode.apiKey);
  // Read once; no child (npm, the publish, the docker CLI) inherits it. Only `aw dev`'s exec gets
  // it, by name, from `mode.apiKey`.
  delete process.env['ANTHROPIC_API_KEY'];
  const work = path.resolve(
    workDirectoryOf(process.env['JOURNEY_WORK_DIR']) ??
      mkdtempSync(path.join(tmpdir(), 'journey-')),
  );
  mkdirSync(work, { recursive: true });
  const evidence = path.join(work, 'evidence');
  mkdirSync(evidence, { recursive: true });
  const registryPort = positiveIntegerVariable('JOURNEY_REGISTRY_PORT', 4873, { max: 65_535 });
  const prepareMs = positiveIntegerVariable(PREPARE_VARIABLE, PREPARE_BUDGET_MS);
  const checksMs = positiveIntegerVariable(CHECKS_VARIABLE, CHECKS_BUDGET_MS);
  const deadline = Date.now() + prepareMs;
  // The post-publish smoke (issue #608): a named registry replaces Verdaccio and the publish.
  const published = registryOf(process.env['JOURNEY_REGISTRY']);
  const registryUrl = published ?? `http://127.0.0.1:${String(registryPort)}/`;
  return {
    firstHour,
    mode,
    work,
    evidence,
    registryPort,
    checksMs,
    deadline,
    published,
    registryUrl,
  };
}

/** @typedef {ReturnType<typeof readRunOptions>} RunOptions */
/** @typedef {{ fake?: { close: () => void }, orders?: { close: () => void } }} LoopbackServers */

/**
 * The one switch point (issue #609): the real API under the repository secret, or the fake on the
 * host's loopback, and the orders API beside it. Every check but the fake's own records runs the
 * same in both.
 *
 * @param {import('./run-basics.mjs').JourneyContext} ctx @param {LoopbackServers} servers
 * @param {ReturnType<typeof journeyMode>} mode
 */
export async function startProviders(ctx, servers, mode) {
  const fakeKey = `${FAKE_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
  SECRETS.add(fakeKey);
  ctx.fakeKey = fakeKey;
  if (mode.live) {
    ctx.anthropic = { ANTHROPIC_API_KEY: mode.apiKey };
    say('== live: the real Anthropic API, under ANTHROPIC_API_KEY');
  } else {
    const fake = await startFakeProvider(ctx.requests, ctx.toolRequests, ctx.bodies);
    servers.fake = fake;
    ctx.anthropic = {
      ANTHROPIC_API_KEY: fakeKey,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(fake.port)}`,
    };
    say(`== fake Anthropic API on 127.0.0.1:${String(fake.port)}`);
  }
  const orders = await serveOnLoopback(ctx.ordersApi.handler, 'the orders API');
  servers.orders = orders;
  ctx.ordersOrigin = `http://127.0.0.1:${String(orders.port)}`;
  say(`== orders API on ${ctx.ordersOrigin}`);
}
