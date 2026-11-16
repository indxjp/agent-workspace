import { PROJECT_FILE_NAME } from '@indx-workspace/sdk/project';
import { isOn, type LocalCommandContext } from '../command.js';
import { detectApp } from '../dev/app.js';
import { devSandbox, requireDocker, unsandboxedLine } from '../dev/sandbox.js';
import { CommandRefusedError, UsageError } from '../io.js';
import {
  anthropicSettings,
  localStartMessage,
  signedInIdentity,
} from '../local-runtime/environment.js';
import { projectSecretNames, readLocalProject } from '../local-runtime/project.js';
import { requireEnginePackages } from '../local-runtime/engine-packages.js';
import { resolveLocalRuntime } from '../local-runtime/resolve.js';
import { loadProject } from '../project/index.js';
import {
  SANDBOXES,
  chooseWebPort,
  withScriptedKeys,
  projectDefaults,
  withSessionKey,
} from './dev-credentials.js';
import { oidcModeOf } from './dev-identity.js';

/**
 * `aw dev`: every check runs before anything is forked — the project, the environment it asks
 * for, the Anthropic settings, the installed runtime and its version — so a refusal never leaves a
 * half-started runtime behind.
 *
 * Every secret the project names — in `agent-workspace.yaml` and in its agents' `secret()` calls —
 * is withheld from the runtime and the loader (SD17): `start` lists them, and once signed in the
 * project's `models` and `connectors` are applied from `aw dev`'s own environment before the first
 * sync (C10, C11). Every sync applies the agents' catalog tools before it saves versions (C15).
 *
 * Once signed in, the sync (issue #453) starts and runs beside the runtime: the sign-in hook
 * returns at once, because the supervisor runs its hooks one after another and waits for them
 * before it reports the runtime's exit. A sync that fails beyond a refusal stops the runtime and
 * is the reason `aw dev` exits with; whatever ends `aw dev`, the sync's watchers and timers are
 * released before it returns, so no push runs after the runtime stopped.
 */
export async function prepareDev(context: LocalCommandContext) {
  const { cwd, signal } = context;
  let { io } = context;
  const read = cwd === undefined ? null : await readLocalProject(cwd);
  if (cwd === undefined || read === null) {
    throw new CommandRefusedError(`no ${PROJECT_FILE_NAME} in this directory`, 'aw init --yes');
  }
  const quiet = isOn(context, 'quiet');
  const verbose = isOn(context, 'verbose');
  if (quiet && verbose) throw new UsageError('--quiet and --verbose cannot be used together');
  if (isOn(context, 'open') && isOn(context, 'no-open'))
    throw new UsageError('--open and --no-open cannot be used together');
  const given = context.args.values.get('sandbox');
  const flag = SANDBOXES.find((name) => name === given);
  if (given !== undefined && flag === undefined)
    throw new UsageError(`--sandbox must be one of ${SANDBOXES.join(', ')}`);
  // Issue #1506: an app in `aw-generated.json` is migrated, started and registered once ready. A
  // manifest that is not one is refused here, before anything is forked.
  const detected = await detectApp(cwd);
  const fileNames = projectSecretNames(read);
  // The flag wins over the project file; with neither, nothing is probed. Both refusals come
  // before the key prompt, so a bad value or a stopped daemon never asks for a key first.
  const sandbox = devSandbox(
    flag,
    localStartMessage(read, cwd, fileNames).environment.runtimeDriver,
  );
  await requireDocker(sandbox, io.env);
  const { defaultEngine, models } = projectDefaults(read);
  // The `secret()` names of the agents' tools are withheld too (ADR-0109 slice-2 amendment). A
  // project with no agents yet names none; any other problem is the first sync's to report.
  // Loaded before the key prompt: a scripted-only project is never asked for a key (#798).
  let agentNames: readonly string[] = [];
  let loaded: Awaited<ReturnType<typeof loadProject>> | undefined;
  try {
    loaded = await loadProject({
      root: cwd,
      io,
      signal,
      withheld: fileNames,
      defaultEngine,
      models,
    });
    agentNames = loaded.secrets;
  } catch (error) {
    if (!(error instanceof CommandRefusedError)) throw error;
  }
  const scriptedIo = withScriptedKeys(
    io,
    read,
    (loaded?.agents ?? []).map(({ body }) => body.definition.agent.model),
  );
  io = scriptedIo ?? (await withSessionKey(io, read, quiet));
  // An unpinned port that is busy moves to the next free set; a pinned one is the runtime's refusal.
  const chosen = await chooseWebPort(context.args.values.get('port'), io, read);
  io = chosen.io;
  const { moved, port: portOverride } = chosen;
  let start = localStartMessage(read, cwd, fileNames, portOverride);
  const identity = signedInIdentity(io.env, start);
  const anthropic = anthropicSettings(io.env);
  const runtime = await resolveLocalRuntime(cwd);
  await requireEnginePackages(
    cwd,
    (loaded?.agents ?? []).map(({ body }) => body.definition.policy.engine),
  );
  const withheld = [...new Set([...fileNames, ...agentNames])].sort();
  if (withheld.length > fileNames.length)
    start = localStartMessage(read, cwd, withheld, portOverride);
  if (flag !== undefined)
    start = { ...start, environment: { ...start.environment, runtimeDriver: flag } };
  // Only docker runs a session in a container; `sandbox-runtime` runs on `local` too (#818).
  const unsandboxed =
    start.environment.runtimeDriver === 'docker'
      ? undefined
      : unsandboxedLine(
          (loaded?.agents ?? [])
            .filter(({ body }) => body.definition.agent.permissions.runCommands)
            .map(({ name }) => name),
        );
  if (unsandboxed !== undefined) io.stderr(unsandboxed);
  const oidcMode = await oidcModeOf(io, cwd);
  return {
    cwd,
    io,
    read,
    quiet,
    verbose,
    detected,
    defaultEngine,
    models,
    scriptedIo,
    moved,
    start,
    identity,
    anthropic,
    runtime,
    withheld,
    oidcMode,
    loaded,
  };
}
