#!/usr/bin/env node
import { createJourneyContext } from './journey-context.mjs';
import { createChatApiStep } from './journey-steps/chat-api.mjs';
import { createConfigureStep } from './journey-steps/configure.mjs';
import { createCreateStep } from './journey-steps/create.mjs';
import { createDeployStep } from './journey-steps/deploy.mjs';
import { createEvalStep } from './journey-steps/eval.mjs';
import { createFrontendStep } from './journey-steps/frontend.mjs';
import { createGateStep } from './journey-steps/gate.mjs';
import { createHostedChatStep } from './journey-steps/hosted-chat.mjs';
import { createRollbackStep } from './journey-steps/rollback.mjs';
import { createWidgetStep } from './journey-steps/widget.mjs';
export {
  failedRunDetail,
  frontendTurn,
  redactingCheck,
  refusedPush,
  refusedRun,
  responseSecrets,
  setupAnswered,
} from './journey-assertions.mjs';
export { createJourneyContext } from './journey-context.mjs';
export {
  frontendFiles,
  JOURNEY_DEPLOYMENT_POLICY,
  pushRuntimeImage,
  setDotEnv,
  storageEntries,
} from './journey-deployment.mjs';
export { awaitSetup } from './journey-http.mjs';
export { pushVercelSandboxImage, vercelLogExcerpt, withVercelLogs } from './journey-vercel.mjs';
/* global console */
/**
 * The lightweight deploy-the-agent-app journey (issue #832, E7 AC2) for one lane: the Z1 journey's
 * chapters (`../build-deploy-journey`, imported, not copied) against a Vercel or Cloudflare
 * deployment instead of a Compose one.
 *
 *   LJ_LANE=vercel-vercel-sandbox LJ_RUN_ID=1 pnpm exec node tests/e2e/lightweight-journey/journey.e2e.mjs
 *
 * Lanes, chapters, skip rules and names are `lanes.mjs`; `teardown.mjs` deletes what this deploys.
 * Environment: `LJ_LANE`, `LJ_RUN_ID` (or `GITHUB_RUN_ID`), `LJ_RESULTS` (default `results.json`),
 * `LJ_WORK_DIR` and the lane's credentials (`lanes.mjs`); no model key. As in the Z1 journey, the eval
 * runs a scripted model and the deployment is set up with a fake `sk-ant-` key (a deployment refuses
 * scripted models outside the local posture). Compose answers `api.anthropic.com` with the scripted
 * fake; a hosted lane cannot alias that host, so every lane deploys the fake as a Cloudflare Worker
 * and setup is given its URL as `providerBaseUrl`. Without a credential the lane is `skipped` on every
 * row, starts no container and exits 0; a failure exits 1 after the results file says which row
 * failed.
 *
 * It needs Docker (the platform images go to a local registry), `npm`, `openssl` and the packages
 * built, and it creates cloud resources: run it through the workflow.
 */
import path from 'node:path';
import process from 'node:process';

import { stopPackages } from '../build-deploy-journey/journey.e2e.mjs';
import { stopRegistry } from '../build-deploy-journey/registry.mjs';

import { redact } from '../../../infra/tests/providers/support.mjs';
import { killLaneSandboxes } from './e2b-sandboxes.mjs';

import { runChapters } from './lanes.mjs';

async function main() {
  const context = createJourneyContext();
  const { lane, record, secrets, s, hidden, check } = context;
  const steps = {
    ...createCreateStep(context),
    ...createEvalStep(context),
    ...createDeployStep(context),
    ...createConfigureStep(context),
    ...createGateStep(context),
    ...createChatApiStep(context),
    ...createHostedChatStep(context),
    ...createWidgetStep(context),
    ...createFrontendStep(context),
    ...createRollbackStep(context),
  };

  /** Success or failure, the lane ends with none of its E2B sandboxes alive (issue #832). */
  async function sweepE2bSandboxes() {
    const workspaceId = s['workspaceId'];
    try {
      // Without its workspace the lane cannot list what it created, so it fails rather than pass
      // with sandboxes it never looked for.
      check(
        typeof workspaceId === 'string',
        'the lane knows its workspace, so its E2B sandboxes can be swept',
      );
      const { after } = await killLaneSandboxes({
        apiKey: process.env['E2B_API_KEY'] ?? '',
        workspaceId: String(workspaceId),
        log: (line) => console.log(redact(line, hidden())),
      });
      if (after !== 0)
        throw new Error(`${String(after)} E2B sandboxes of this lane are still alive`);
    } catch (error) {
      console.error(redact(error instanceof Error ? error.message : String(error), hidden()));
      process.exitCode = 1;
    }
  }

  try {
    await runChapters(lane, process.env, steps, record, () => secrets);
    process.exitCode = context.failed ? 1 : 0;
  } finally {
    if (context.removeBridge !== null) await context.removeBridge().catch(() => {});
    if (lane.sandbox === 'e2b') await sweepE2bSandboxes();
    if (context.prepared) {
      stopRegistry();
      stopPackages();
    }
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
