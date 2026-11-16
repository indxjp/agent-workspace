import { type CliIo } from '../io.js';
import { nonBlank } from '../config.js';
import { formatProblem, problemCount, type PushReport } from '../project/index.js';
import { EDITED_IN_UI_CODE, missingFolders, withMissingFolderHint } from '../project/problems.js';
import { surfaceLines, syncSummary } from './format.js';

/**
 * A `secret()` named after start whose value is set: the runtime was forked with it in its
 * environment, and only a restart withholds it there. An unset one is said by the plan's notice.
 */
export function namedLateLine(name: string): string {
  return `${name} was in aw dev's environment when the runtime started; restart aw dev to withhold it from the runtime\n`;
}

interface SyncReporterOptions {
  readonly io: CliIo;
  readonly origin: string;
  readonly withheld: Set<string>;
  readonly printed: Set<string>;
}

export function createSyncReporter({ io, origin, withheld, printed }: SyncReporterOptions) {
  // The agents the last clean sync held, by name: one gone from the project since is said once.
  let synced = new Map<string, { readonly file: string; readonly agentId: string | null }>();
  const reportRemoved = (pushed: PushReport): void => {
    if (pushed.problems.length > 0) return;
    const now = new Map(pushed.agents.map(({ name, file, agentId }) => [name, { file, agentId }]));
    for (const [name, { file, agentId }] of synced) {
      if (now.has(name) || agentId === null) continue;
      io.stderr(
        `notice: ${file} no longer defines "${name}", which stays in the local workspace ` +
          `(aw chat then asks which agent); remove it with aw agents remove ${agentId}\n`,
      );
    }
    synced = now;
  };

  const report = (pushed: PushReport): void => {
    reportRemoved(pushed);
    for (const name of pushed.secrets) {
      if (withheld.has(name)) continue;
      withheld.add(name);
      // Read from aw dev's environment by the tool step; only an unset one needs saying.
      if (nonBlank(io.env[name]) !== undefined) io.stderr(namedLateLine(name));
    }
    if (pushed.agents.length > 0 || pushed.skills.skills.some((s) => s.action !== 'unchanged')) {
      io.stdout(`${syncSummary(pushed.agents, pushed.skills)}\n`);
    }
    for (const problem of pushed.problems) {
      io.stdout(`${formatProblem(withMissingFolderHint(problem))}\n`);
    }
    if (pushed.problems.length > 0) {
      // Saving the file again does not clear an edit made in the UI, nor an empty file folder.
      // A refused check writes nothing (BH061-047): say so, or a surface edit seems lost.
      const advice = syncAdvice(pushed);
      io.stderr(`sync: ${problemCount(pushed.problems.length)}; ${advice}\n`);
    }
    for (const agent of pushed.agents) {
      for (const name of agent.surfaces) {
        if (printed.has(name)) continue;
        printed.add(name);
        for (const line of surfaceLines(origin, name)) io.stdout(`${line}\n`);
      }
    }
  };

  return report;
}

function syncAdvice(pushed: PushReport): string {
  if (pushed.problems.every((problem) => problem.code === EDITED_IN_UI_CODE)) {
    return 'those agents keep their UI edit until aw push --yes overwrites them';
  }
  if (pushed.problems.every((problem) => missingFolders(problem) !== undefined)) {
    return 'upload the files named above, then save a file or run aw push --yes to sync again';
  }
  return pushed.agents.length === 0
    ? 'nothing was synced; fix the file and save to sync again'
    : 'fix the file and save to sync again';
}
