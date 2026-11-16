/** @typedef {ReturnType<typeof import('./run.d.mts').parseArguments>} ClaimOptions */
/**
 * @typedef {import('./run.d.mts').Machine} Machine
 * @typedef {import('./run.d.mts').Row} Row
 * @typedef {import('./extract.mjs').Claim} Claim
 */
import { personRows } from './run-person-claims.mjs';
import { compileRows } from './run-compile-claims.mjs';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { positiveIntegerVariable } from '../generated-project/run.mjs';
import { JourneyFailure, quickstartCommands } from '../journey/harness.mjs';
import {
  FAKE_KEY_PREFIX,
  SECRETS,
  execOk,
  publishPackages,
  removeContainer,
  say,
  startFakeProvider,
  startMachine,
  startRegistry,
} from '../journey/run.mjs';
import { createHostMachine } from './host.mjs';
import { COMMAND_VARIABLE, COMMAND_TIMEOUT_MS, QUICKSTART_PAGE } from './run-config.mjs';
import { runPlans, readRepositoryFile } from './run-plans.mjs';
import { shell, containerMachine, ownedRows, runPage } from './run-execution.mjs';

async function createClaimMachine({
  options,
  work,
  registryUrl,
  model,
  logs,
  machineName,
  deadline,
}) {
  const env = { CI: 'true', ...model };
  const commandMs = positiveIntegerVariable(COMMAND_VARIABLE, COMMAND_TIMEOUT_MS);
  /** @type {Machine} */
  let machine;
  if (options.machine === 'host') {
    say(`== using this computer (${process.platform}), shell ${options.shell}`);
    machine = createHostMachine({
      shell: /** @type {'sh' | 'bash' | 'pwsh'} */ (options.shell),
      work,
      registry: registryUrl,
      env,
      commandMs,
      logs,
    });
    await machine.mkdir(machine.claims);
    const installed = await machine.exec("npm install --global '@indx-workspace/aw'", {
      cwd: machine.claims,
      timeoutMs: commandMs,
    });
    if (installed.status !== 0) {
      throw new JourneyFailure(
        `npm install --global @indx-workspace/aw failed\n${installed.output}`,
      );
    }
  } else {
    say('== starting the clean machine');
    await startMachine(machineName, registryUrl, deadline);
    machine = containerMachine(machineName, env, commandMs, logs);
    await execOk(machineName, shell('npm install --global @indx-workspace/aw'), {
      timeoutMs: commandMs,
      quiet: true,
    });
  }

  return machine;
}

async function executeMachineClaims({ options, claims, machine, work, partial, modelMissing }) {
  // Only on the journey's own machine, registry and model is the first-hour leg the same proof.
  const owned =
    options.machine === 'container' && options.registry === null && !options.live
      ? quickstartCommands(readRepositoryFile(QUICKSTART_PAGE) ?? '')
      : [];
  /** @type {Row[]} */
  const rows = [];
  /** @type {Map<string, Row[]>} */
  const done = new Map();
  for (const plan of runPlans(claims)) {
    const pageRows = ownedRows(plan, owned) ?? (await runPage(machine, plan, done, modelMissing));
    done.set(plan.page, pageRows);
    rows.push(...pageRows);
    partial(rows);
  }
  rows.push(...(await personRows(machine)));
  rows.push(...(await compileRows(machine, claims, work)));
  return rows;
}

async function createClaimProvider(options) {
  /** @type {Record<string, string>} */
  let model;
  let fake;
  // A live model without a key is a skipped model, not a stopped run: the rows say so.
  const modelMissing = options.live && options.apiKey === '';
  if (options.live) {
    model = modelMissing ? {} : { ANTHROPIC_API_KEY: options.apiKey };
  } else {
    const key = `${FAKE_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
    SECRETS.add(key);
    fake = await startFakeProvider([], [], []);
    model = {
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(fake.port)}`,
    };
  }
  return { model, modelMissing, fake };
}

/**
 * Everything that needs a machine (the container or this computer): the run claims, the compile
 * claims, the `aw` rows.
 *
 * @param {{options: ClaimOptions, claims: readonly Claim[], work: string, logs: string, partial: (rows: readonly Row[]) => void}} context
 * @returns {Promise<Row[]>}
 */
export async function machineRows({ options, claims, work, logs, partial }) {
  const prepareMs = positiveIntegerVariable('JOURNEY_PREPARE_TIMEOUT_MS', 10 * 60_000);
  const deadline = Date.now() + prepareMs;
  const port = positiveIntegerVariable('JOURNEY_REGISTRY_PORT', 4873, { max: 65_535 });
  const suffix = randomBytes(4).toString('hex');
  const registry = `docs-claims-registry-${suffix}`;
  const machineName = `docs-claims-machine-${suffix}`;
  const secrets = mkdtempSync(path.join(tmpdir(), 'docs-claims-secrets-'));
  const registryUrl = options.registry ?? `http://127.0.0.1:${String(port)}/`;
  /** @type {{ port: number, close: () => void } | undefined} */
  let fake;
  try {
    if (options.registry === null) {
      say(`== starting Verdaccio on ${registryUrl}`);
      await startRegistry(registry, port, deadline);
      say('== packing and publishing the nine @indx-workspace packages');
      await publishPackages(work, secrets, registryUrl, deadline);
    } else {
      say(`== installing from ${registryUrl}`);
    }
    const provider = await createClaimProvider(options);
    const { model, modelMissing } = provider;
    fake = provider.fake;
    const machine = await createClaimMachine({
      options,
      work,
      registryUrl,
      model,
      logs,
      machineName,
      deadline,
    });
    return await executeMachineClaims({ options, claims, machine, work, partial, modelMissing });
  } finally {
    rmSync(secrets, { recursive: true, force: true });
    removeContainer(machineName);
    removeContainer(registry);
    fake?.close();
  }
}
