/**
 * What the scripted model of a document entry (`office-writer`) does, as the entries' instructions
 * say: read the notes, search and read the sources, write the document model to `drafts/` with
 * `Write`, and render it with one `run_skill_script` call of `office-writer`'s `write.mjs` into
 * `outputs/`. That call waits for approval; the approved continuation makes the same call, the real
 * script writes the real file, and the answer names it. A render the script refuses fails the
 * recording, so a recording never shows a document the script would not write.
 */
import { z } from 'zod';

import type { Script } from '../../gallery/harness/scripted-workspace.ts';
import { isContinuation, read, search } from './use-case-script.ts';

/** What `write.mjs` prints when it wrote the file. */
const WRITTEN = z.object({ written: z.string(), bytes: z.number().int().positive() });

/** What a document entry's run does before its gated render. */
export interface RenderPlan {
  /** Files to read without searching for them: the notes the request names. */
  readonly open: readonly string[];
  /** `search_files` queries; every file they find is read, bar one already opened. */
  readonly queries: readonly string[];
  /** Files the search must find: the recording fails without them, as the document rests on them. */
  readonly needs: readonly string[];
  /**
   * The folder of the request's language (`proposal/ja/`): a file the search finds outside it is
   * not read, as the instructions read only the files of the request's language.
   */
  readonly within: string;
  /** The document's name, as the instructions form it, without folder or extension. */
  readonly name: string;
  /** The `office-writer` model: its `format` is the output's extension. */
  readonly model: Readonly<{ format: 'docx' | 'pptx' } & Record<string, unknown>>;
  /** The answer after the approved render: the outline the person approved and the file's name. */
  readonly answer: string;
}

/** The workspace paths of `plan`'s model and output. */
export function renderPaths(plan: Pick<RenderPlan, 'name' | 'model'>): {
  readonly draft: string;
  readonly output: string;
} {
  return {
    draft: `drafts/${plan.name}.json`,
    output: `outputs/${plan.name}.${plan.model.format}`,
  };
}

/**
 * A document entry's run: read, search and read what it found, `Write` the model, then the one
 * `run_skill_script` render the agent gates. The run stops there for approval; the approved
 * continuation makes that same call, which must write the file.
 */
export function rendering(plan: RenderPlan): Script {
  const { draft, output } = renderPaths(plan);
  const render = { skill: 'office-writer', script: 'write.mjs', args: [draft, output] };
  return async (context) => {
    if (isContinuation(context.prompt)) {
      const result = await context.builtin('run_skill_script', render);
      if (result.isError) throw new Error(`write.mjs refused ${output}: ${result.text}`);
      const { written } = WRITTEN.parse(JSON.parse(result.text));
      if (written !== output) throw new Error(`write.mjs wrote ${written}, not ${output}`);
      return plan.answer;
    }
    await read(context, plan.open);
    const found = await search(context, plan.queries);
    const missing = plan.needs.filter((file) => !found.includes(file));
    if (missing.length > 0) throw new Error(`search found no ${missing.join(', ')}`);
    await read(
      context,
      found.filter((file) => file.startsWith(plan.within) && !plan.open.includes(file)),
    );
    const wrote = await context.native('Write', {
      file_path: `/workspace/${draft}`,
      content: `${JSON.stringify(plan.model, null, 2)}\n`,
    });
    if (wrote.isError) throw new Error(`Write ${draft}: ${wrote.text}`);
    await context.builtin('run_skill_script', render);
    // A gated render stops the run above; one that answered here ran without its approval.
    throw new Error(`${output}: the render was not gated`);
  };
}
