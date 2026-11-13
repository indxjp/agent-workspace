import type { ProjectRead } from '@indx-workspace/contracts/project-file';
import { UsageError, type CliIo } from '../io.js';
import { nonBlank } from '../config.js';
import { applyProjectResources, plannedProject } from '../local-runtime/project-resources.js';
import { projectSecretNames, readLocalProject } from '../local-runtime/project.js';
import { namedLateLine } from './sync-report.js';
import { type DevSyncOptions } from './sync.js';

/**
 * Issue #695: the keys of `agent-workspace.yaml` only a new runtime takes, as one line each: the
 * port, the runtime driver, the default engine, the policy and the features (#1495), which the
 * runtime reads when it starts. Compared with the file as `aw dev` started, so a pending change is
 * said once.
 */
function restartLines(before: ProjectRead, after: ProjectRead): readonly string[] {
  if (before.lifted || after.lifted) return [];
  const keys = (read: typeof before): Record<string, unknown> => ({
    'environments.local.port': read.project.environments.local?.port,
    'environments.local.runtime': read.project.environments.local?.runtime,
    engine: read.project.engine,
    policy: read.project.policy,
    features: read.project.features,
  });
  const was = keys(before);
  const now = keys(after);
  return Object.keys(was).flatMap((name) =>
    JSON.stringify(was[name]) === JSON.stringify(now[name])
      ? []
      : [`agent-workspace.yaml: ${name} changed; restart aw dev to apply\n`],
  );
}

interface ProjectFileSyncState {
  readonly withheld: Set<string>;
  readonly printedNotices: Set<string>;
  readonly stopped: AbortSignal;
}

export function createProjectFileSync(options: DevSyncOptions, state: ProjectFileSyncState) {
  const { io, root } = options;
  const { withheld, printedNotices, stopped } = state;
  let project = options.project;
  let projectFileChanged = false;
  // Issue #695: a save of agent-workspace.yaml is read again and applied before the agents sync.
  const applyProjectFile = async (): Promise<void> => {
    const live = options.liveProject;
    if (live === undefined || !projectFileChanged) return;
    // Cleared first: a save during the apply sets it again, and a failed apply restores it.
    projectFileChanged = false;
    // Each line prints once per session, so saving the file again repeats nothing.
    const once: CliIo = {
      ...io,
      stderr: (text) => {
        if (printedNotices.has(text)) return;
        printedNotices.add(text);
        io.stderr(text);
      },
    };
    try {
      let read: ProjectRead | null;
      try {
        read = await readLocalProject(root);
      } catch (error) {
        if (!(error instanceof UsageError)) throw error;
        io.stderr(`sync: ${error.message}
`);
        return;
      }
      if (read === null) return;
      for (const line of restartLines(live.read, read)) once.stderr(line);
      await applyProjectResources({ ...live, read, root, io: once, signal: stopped });
      for (const name of projectSecretNames(read)) {
        if (withheld.has(name)) continue;
        withheld.add(name);
        // The model secrets were named to the runtime at start on purpose.
        if (live.start.environment.modelSecrets?.includes(name) === true) continue;
        // An unset one is said by the plan's notice; a set one is in the runtime's environment.
        if (nonBlank(io.env[name]) !== undefined) io.stderr(namedLateLine(name));
      }
      project = plannedProject(read, live.start);
    } catch (error) {
      projectFileChanged = true;
      throw error;
    }
  };

  return {
    project: () => project,
    changed: () => {
      projectFileChanged = true;
    },
    apply: applyProjectFile,
  };
}
