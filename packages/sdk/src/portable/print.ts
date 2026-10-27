import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import { NAME_KEY_PATTERN, type ProjectConnector } from '@indx-workspace/contracts/project-file';

import { DefinitionError, issuesFromZod } from '../define/errors.js';
import type { AgentVersionSource } from '../define/from-version-body.js';
import { PrintError, printDefineAgent } from './print-ts.js';

export { PrintError };

const SUBJECT = 'printAgentProject()';

export interface PrintOptions {
  /** Where `defineAgent` and the helpers are imported from. Default `@indx-workspace/sdk/define`. */
  readonly importPath?: string | undefined;
}

/** One file of the printed project: a project-relative POSIX path and its text. */
export interface PrintedFile {
  readonly path: string;
  readonly text: string;
}

/** The files to write, and the `agent-workspace.yaml` entries the agent's `mcp()` tools need. */
export interface PrintedAgentProject {
  readonly files: readonly PrintedFile[];
  /** `connectors:` entries, verbatim; the printer never writes `agent-workspace.yaml` itself. */
  readonly connectors: Readonly<Record<string, ProjectConnector>>;
}

/**
 * A version body as the two files a project keeps in Git: `agents/<name>.ts` (a `defineAgent`
 * call that imports its module tools from `../tools/…`) and `agents/<name>.md` (the instructions,
 * exactly as stored). Pure: nothing is read, written or fetched, so `aw pull` and the console can
 * reuse it. The result's `connectors` are the yaml entries those files need.
 *
 * @throws {DefinitionError} when the body is not a version body, or its agent name is not a
 *   project name (lower-case kebab, at most 64 characters): the name is the file name, so a name
 *   with `/` or `..` is refused here.
 * @throws {PrintError} when a part of the body cannot be written as code.
 */
export function printAgentProject(
  source: AgentVersionSource,
  options: PrintOptions = {},
): PrintedAgentProject {
  const parsed = AgentVersionBodySchema.safeParse(source.body);
  if (!parsed.success) throw new DefinitionError(SUBJECT, issuesFromZod(parsed.error, 'body'));
  const { name, instructions } = parsed.data.definition.agent;
  if (!NAME_KEY_PATTERN.test(name)) {
    throw new DefinitionError(SUBJECT, [
      {
        path: 'body.definition.agent.name',
        message: 'must be lower-case letters, digits and inner hyphens, at most 64 characters',
      },
    ]);
  }
  const { text, connectors } = printDefineAgent(source, {
    importPath: options.importPath ?? '@indx-workspace/sdk/define',
  });
  return {
    files: [
      { path: `agents/${name}.ts`, text },
      { path: `agents/${name}.md`, text: instructions },
    ],
    connectors,
  };
}
