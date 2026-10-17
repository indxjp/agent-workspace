import {
  PortableAgentSchema,
  type PortableAgent,
  type PortableAgentInput,
} from '@indx-workspace/contracts/portable-agent';

import { DefinitionError, issuesFromZod } from '../define/errors.js';
import { ProjectRenderError } from '../project/errors.js';
import { ProjectFileError, readProjectFileText, schemaRefusal } from '../project/reader.js';
import { writeProjectFileText } from '../project/writer.js';

/** The suffix of an interchange file: `agents/<name>.agent.md` (ADR-0133 D3). */
export const AGENT_MARKDOWN_SUFFIX = '.agent.md';

const FENCE = '---';

/** The lists that are left out of the front matter when they are empty. */
const OMITTED_WHEN_EMPTY: ReadonlySet<string> = new Set([
  'tools',
  'skills',
  'knowledge',
  'subagents',
]);

/**
 * Reads an `.agent.md` file into a frozen {@link PortableAgent}: YAML front matter between two
 * `---` lines, then the instructions as Markdown. The front matter is read with the project file's
 * reader, so every refusal of ADR-0089 (anchors, aliases, tags, duplicate keys, a second document,
 * nesting depth) applies, and `label` is the file the refusals name. CRLF line endings are read as LF.
 *
 * @throws {ProjectFileError} at the file's own line and column.
 */
export function parseAgentMarkdown(text: string, label: string): PortableAgent {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const refuse = (line: number, detail: string): ProjectFileError =>
    new ProjectFileError({ line, column: 1 }, detail, undefined, label);

  if (lines[0] !== FENCE) throw refuse(1, `must start with a '${FENCE}' front matter line`);
  const closing = lines.indexOf(FENCE, 1);
  if (closing === -1) {
    const lastLine = lines.length > 1 && lines.at(-1) === '' ? lines.length - 1 : lines.length;
    throw refuse(lastLine, `the front matter is not closed with '${FENCE}'`);
  }

  // The leading newline stands in for the opening fence, so a line number is the file's own.
  const reading = readProjectFileText(`\n${lines.slice(1, closing).join('\n')}`, label);
  const frontMatter = reading.value;
  if (typeof frontMatter !== 'object' || frontMatter === null || Array.isArray(frontMatter)) {
    throw new ProjectFileError(
      reading.locate([]),
      'the front matter must be a mapping',
      undefined,
      label,
    );
  }
  if (Object.hasOwn(frontMatter, 'instructions')) {
    throw new ProjectFileError(
      reading.locate(['instructions']),
      'the instructions are the Markdown body, not a front matter key',
      'instructions',
      label,
    );
  }

  const body = lines.slice(closing + 1).join('\n');
  const instructions = body.replace(/^\n/u, '').replace(/\n$/u, '');
  const result = PortableAgentSchema.safeParse({ ...frontMatter, instructions });
  if (result.success) return result.data;

  const [issue] = result.error.issues;
  if (issue?.path.length === 1 && issue.path[0] === 'instructions') {
    // The body is not YAML and has no position of its own; name the line after the closing fence.
    throw new ProjectFileError(
      { line: closing + 2, column: 1 },
      `instructions ${issue.message}`,
      'instructions',
      label,
    );
  }
  throw schemaRefusal(reading, result.error, 'is not a valid agent', label);
}

/**
 * Writes the canonical `.agent.md` text that {@link parseAgentMarkdown} reads back deep-equal:
 * the front matter in the schema's key order without `instructions` and without empty lists, then
 * the instructions as the body. Instructions are written as given, except that a CRLF inside them
 * reads back as LF.
 *
 * @throws {DefinitionError} when `agent` does not parse as `PortableAgentSchema`.
 * @throws {ProjectRenderError} when a value cannot be written (for example a list inside a list).
 */
export function formatAgentMarkdown(agent: PortableAgentInput): string {
  const parsed = PortableAgentSchema.safeParse(agent);
  if (!parsed.success) {
    throw new DefinitionError('formatAgentMarkdown()', issuesFromZod(parsed.error));
  }
  const { instructions, ...rest } = parsed.data;
  const frontMatter = Object.fromEntries(
    Object.entries(rest).filter(
      ([key, value]) =>
        value !== undefined &&
        !(OMITTED_WHEN_EMPTY.has(key) && Array.isArray(value) && value.length === 0),
    ),
  );
  let yaml: string;
  try {
    yaml = writeProjectFileText(frontMatter);
  } catch (error) {
    // The writer names the project file; the refusal is about this agent's file.
    if (error instanceof ProjectRenderError) {
      throw new ProjectRenderError(`${parsed.data.name}${AGENT_MARKDOWN_SUFFIX}`, error.issues);
    }
    throw error;
  }
  return `${FENCE}\n${yaml}${FENCE}\n\n${instructions}\n`;
}
