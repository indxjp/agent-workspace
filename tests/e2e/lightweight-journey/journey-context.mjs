import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { positiveIntegerVariable } from '../../generated-project/run.mjs';
import * as assertions from './journey-assertions.mjs';
import * as constants from './journey-constants.mjs';
import * as deployment from './journey-deployment.mjs';
import * as http from './journey-http.mjs';
import * as vercel from './journey-vercel.mjs';
import { LANES, resourceNames, resultsWriter } from './lanes.mjs';

/**
 * Fields are populated in chapter order. runChapters stops on failure before a later chapter
 * can read an unset value. Only the Cloudflare sandbox lane uses bridge fields.
 * @typedef {{
 * npmUrl:string, home:string, evidence:string, userEnv:NodeJS.ProcessEnv,
 * images:{overrides:Record<string,string>,toolHost:string,egressProxy:string},
 * created:import('../build-deploy-journey/journey.e2e.mjs').CreatedProject,
 * controlUrl:string, frontendUrl:string, workersSubdomain:string,
 * bridgeUrl?:string, bridgeSecret?:string, stateEnv:Record<string,string>,
 * providerUrl:string, providerKey:string,
 * client:import('../../generated-project/stack-api.mjs').StackClient,
 * apiKey:string, workspaceId?:string, declared:string, agentId:string, pushRefused?:string
 * }} JourneyState
 */

function readJourneyIdentity() {
  const lane = LANES.find((candidate) => candidate.id === process.env['LJ_LANE']);
  if (lane === undefined)
    throw new Error(`LJ_LANE must be one of ${LANES.map((l) => l.id).join(', ')}`);
  const runId = process.env['LJ_RUN_ID'] ?? process.env['GITHUB_RUN_ID'] ?? String(Date.now());
  process.env['GITHUB_RUN_ID'] = runId;
  return { lane, runId, names: resourceNames(lane, runId) };
}

/** @param {ReturnType<typeof readJourneyIdentity>['lane']} lane */
function createProgressRecorder(lane) {
  const write = resultsWriter(
    lane.id,
    writeFileSync,
    path.resolve(process.env['LJ_RESULTS'] ?? 'results.json'),
  );
  let failed = false;
  const record = (
    /** @type {string} */ id,
    /** @type {string} */ outcome,
    /** @type {string|undefined} */ detail,
  ) => {
    if (outcome === 'fail') failed = true;
    write(id, outcome, detail);
  };
  return {
    write,
    record,
    get failed() {
      return failed;
    },
  };
}

function readJourneyPreparation() {
  const work = path.resolve(
    process.env['LJ_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'lightweight-journey-')),
  );
  const npmPort = positiveIntegerVariable('BD_NPM_PORT', 4873, { max: 65535 });
  const registryPort = positiveIntegerVariable('BD_REGISTRY_PORT', 5000, { max: 65535 });
  const deadline = Date.now() + positiveIntegerVariable('BD_PREPARE_TIMEOUT_MS', 45 * 60000);
  return { work, npmPort, registryPort, deadline };
}

/** @param {{identity:ReturnType<typeof readJourneyIdentity>,secrets:string[],s:JourneyState}} state */
function createJourneyRequests({ identity: { lane, names }, secrets, s }) {
  const hidden = () => lane.credentials.map((name) => process.env[name] ?? '').concat(secrets);
  const check = assertions.redactingCheck(hidden);
  // Credentials are remembered before any line can print an answer.
  /** @template {{json:unknown}} T @param {T} answer @returns {T} */
  const remember = (answer) => {
    secrets.push(...assertions.responseSecrets(answer.json));
    return answer;
  };
  const ask = (/** @type {string} */ url, /** @type {Parameters<typeof http.call>[1]} */ init) =>
    http.call(url, init).then(remember);
  const sandboxDriver = lane.sandbox === 'e2b' ? 'external' : lane.sandbox;
  const control = () => s['controlUrl'];
  const controlPlaneLogs = (/** @type {unknown} */ error) => {
    secrets.push(process.env['VERCEL_TOKEN'] ?? '');
    return vercel.withVercelLogs(error, {
      targets: [
        ['control plane', control()],
        ['manager', `https://${names.project}-manager.vercel.app`],
      ],
      team: process.env['VERCEL_TEAM_ID'] ?? '',
      token: process.env['VERCEL_TOKEN'] ?? '',
    });
  };
  const bearer = () => ({
    ...s['userEnv'],
    AGENT_WORKSPACE_URL: control(),
    AGENT_WORKSPACE_API_KEY: s['apiKey'],
  });
  const frontendDir = () => path.join(s['created'].project, 'web');
  return {
    hidden,
    check,
    remember,
    ask,
    sandboxDriver,
    control,
    controlPlaneLogs,
    bearer,
    frontendDir,
  };
}

export function createJourneyContext() {
  const identity = readJourneyIdentity();
  const progress = createProgressRecorder(identity.lane);
  /** @type {string[]} */ const secrets = [];
  const s = /** @type {JourneyState} */ ({});
  const preparation = readJourneyPreparation();
  /** @type {null|(()=>Promise<void>)} */ let removeBridge = null;
  let prepared = false;
  const requests = createJourneyRequests({ identity, secrets, s });
  return {
    ...constants,
    ...deployment,
    ...http,
    ...assertions,
    ...vercel,
    ...identity,
    write: progress.write,
    record: progress.record,
    secrets,
    s,
    ...preparation,
    ...requests,
    get failed() {
      return progress.failed;
    },
    get prepared() {
      return prepared;
    },
    set prepared(value) {
      prepared = value;
    },
    get removeBridge() {
      return removeBridge;
    },
    set removeBridge(value) {
      removeBridge = value;
    },
  };
}
