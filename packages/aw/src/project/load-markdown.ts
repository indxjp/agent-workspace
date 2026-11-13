import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as define from '@indx-workspace/sdk/define';
import {
  AGENT_MARKDOWN_SUFFIX,
  defineAgentFromPortable,
  parseAgentMarkdown,
} from '@indx-workspace/sdk/portable';
import { ProjectFileError } from '@indx-workspace/sdk/project';
import { localProblem, type ProjectProblem } from './problems.js';
import { type LoadedAgentEntry } from './load-assembly.js';
import { AGENT_MARKDOWN_FILES, type DefinitionFiles, definitionFiles } from './load-discovery.js';
import { type LoadProjectOptions } from './load-types.js';

/** One `agents/<name>.agent.md` (ADR-0166 D12): the agent it defines, or why it is refused. */
type MarkdownAgent =
  | { readonly kind: 'agent'; readonly entry: LoadedAgentEntry }
  | { readonly kind: 'problem'; readonly problem: ProjectProblem };

function definitionIssues(error: define.DefinitionError): readonly string[] {
  return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

/**
 * Read one `agents/<name>.agent.md` here, never in the child: the file is data, not code. It is
 * parsed with `parseAgentMarkdown` and made through `defineAgentFromPortable`, so every check
 * `defineAgent()` makes applies, then becomes a version body as an `agents/<name>.ts` would. A file
 * whose agent is not named like it, and a conversion that drops anything (ADR-0133 D5), are
 * refused: what is pushed is exactly what the file says.
 */
async function markdownAgent(
  root: string,
  file: string,
  options: LoadProjectOptions,
): Promise<MarkdownAgent> {
  const refuse = (code: string, details: readonly string[]): MarkdownAgent => ({
    kind: 'problem',
    problem: localProblem(file, code, details),
  });
  let text: string;
  try {
    text = await readFile(path.join(root, ...file.split('/')), 'utf8');
  } catch {
    return refuse('agent_markdown_invalid', ['the file could not be read']);
  }
  try {
    const portable = parseAgentMarkdown(text, file);
    const expected = `agents/${portable.name}${AGENT_MARKDOWN_SUFFIX}`;
    if (file !== expected) {
      return refuse('agent_markdown_invalid', [
        `the file defines the agent ${portable.name}; name it ${expected}`,
      ]);
    }
    const conversion = defineAgentFromPortable(
      portable,
      options.models === undefined ? {} : { models: options.models },
    );
    if (conversion.dropped.length > 0) {
      return refuse(
        'agent_conversion_lossy',
        conversion.dropped.map((drop) => `${drop.path}: ${drop.reason}`),
      );
    }
    const agent = conversion.value;
    const body = define.toAgentVersionBody(
      agent,
      options.defaultEngine === undefined ? {} : { defaultEngine: options.defaultEngine },
    );
    const secrets = define
      .toolDefinitionsOf(agent)
      .flatMap((tool) => (tool.credential === undefined ? [] : [tool.credential.secret]));
    const tools = (agent.tools ?? []).flatMap((tool) =>
      define.isOpenApiTool(tool) ? [{ file, kind: 'openapi' as const, tool: { ...tool } }] : [],
    );
    return {
      kind: 'agent',
      entry: { file, kind: 'agent', name: agent.name, body, secrets: [...new Set(secrets)], tools },
    };
  } catch (error) {
    if (error instanceof ProjectFileError) return refuse('agent_markdown_invalid', [error.message]);
    if (error instanceof define.DefinitionError) {
      return {
        kind: 'problem',
        problem: {
          file,
          status: 400,
          code: 'invalid_agent_version',
          details: definitionIssues(error),
        },
      };
    }
    throw error;
  }
}

/** The stem of an agent file: `support` for `agents/support.ts` and `agents/support.agent.md`. */
function agentStem(file: string): string {
  const name = file.slice('agents/'.length);
  return name.endsWith(AGENT_MARKDOWN_SUFFIX)
    ? name.slice(0, -AGENT_MARKDOWN_SUFFIX.length)
    : name.slice(0, -'.ts'.length);
}

/**
 * The project's `agents/*.agent.md` agents (ADR-0166 D12). A name a `.ts` file also defines is
 * refused on the `.agent.md` file: ADR-0133 D3 allows one definition per name.
 */
export async function markdownAgents(
  root: string,
  rootReal: string,
  typescript: DefinitionFiles,
  options: LoadProjectOptions,
): Promise<{
  readonly entries: readonly LoadedAgentEntry[];
  readonly problems: readonly ProjectProblem[];
}> {
  if (options.agentMarkdown === false) return { entries: [], problems: [] };
  const listed = await definitionFiles(root, rootReal, 'agents', AGENT_MARKDOWN_FILES);
  const typed = new Set(
    [...typescript.files, ...typescript.problems.map((problem) => problem.file)].map(agentStem),
  );
  const entries: LoadedAgentEntry[] = [];
  const problems: ProjectProblem[] = [...listed.problems];
  for (const file of listed.files) {
    const stem = agentStem(file);
    if (typed.has(stem)) {
      problems.push(
        localProblem(file, 'agent_defined_twice', [
          `agents/${stem}.ts also defines ${stem}; keep one of the two files`,
        ]),
      );
      continue;
    }
    const read = await markdownAgent(root, file, options);
    if (read.kind === 'agent') entries.push(read.entry);
    else problems.push(read.problem);
  }
  return { entries, problems };
}
