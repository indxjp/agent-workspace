import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { EvalCaseFile } from '@indx-workspace/contracts/evaluations';
import { ProjectFileError, readEvalCaseFile } from '@indx-workspace/sdk/project';
import { UsageError } from '../io.js';

/** The directory of a project's evaluation case files, one `<agent>.yaml` per agent (issue #618). */
const EVALS_DIRECTORY = 'evals';

/** The agents with an `evals/<agent>.yaml`, sorted; none is a usage error that says to name one. */
export async function evalAgents(root: string): Promise<readonly string[]> {
  let names: readonly string[];
  try {
    names = (await readdir(path.join(root, EVALS_DIRECTORY))).filter((name) =>
      name.endsWith('.yaml'),
    );
  } catch {
    names = [];
  }
  if (names.length === 0) {
    throw new UsageError(
      `missing <agent>: name the agent whose ${EVALS_DIRECTORY}/<agent>.yaml to run`,
    );
  }
  return names.map((name) => name.slice(0, -'.yaml'.length)).sort();
}

/**
 * The agent an `aw feedback` without one is about: the only `evals/*.yaml` file's agent. Several,
 * or none, is a usage error that says to name one.
 */
export async function soleEvalAgent(root: string): Promise<string> {
  const names = await evalAgents(root);
  const [only] = names;
  if (only === undefined || names.length > 1) {
    throw new UsageError(
      `missing <agent>: name the agent whose ${EVALS_DIRECTORY}/<agent>.yaml to run` +
        ` (found ${names.map((name) => `${name}.yaml`).join(', ')})`,
    );
  }
  return only;
}

/**
 * `evals/<agentName>.yaml`, relative to the project root. A name that is not one file name is a
 * usage error, so no agent name can reach outside `evals/`.
 */
export function evalCaseFileLabel(agentName: string): string {
  if (agentName !== path.basename(agentName) || agentName === '.' || agentName === '..') {
    throw new UsageError(
      `<agent> ${JSON.stringify(agentName)} is not a file name in ${EVALS_DIRECTORY}/`,
    );
  }
  return `${EVALS_DIRECTORY}/${agentName}.yaml`;
}

/**
 * Read `evals/<agentName>.yaml` under `root` (issue #618). A missing or unreadable file, a name that
 * is not one file name, and a file the reader or `EvalCaseFileSchema` refuses are usage errors
 * naming the file (and the line and column).
 */
export async function loadEvalCases(root: string, agentName: string): Promise<EvalCaseFile> {
  const label = evalCaseFileLabel(agentName);
  let text: string;
  try {
    text = await readFile(path.join(root, label), 'utf8');
  } catch {
    throw new UsageError(`could not read ${label}: write the agent's evaluation cases there`);
  }
  try {
    return readEvalCaseFile(text, label);
  } catch (error) {
    if (error instanceof ProjectFileError) throw new UsageError(error.message);
    throw error;
  }
}
