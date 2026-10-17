/**
 * `tests/conformance/spec-scenarios.ts` — reads Appendix A.12's ten scenario lines directly out of
 * `docs/spec.md`, rather than trusting a hand-typed list.
 *
 * This is the same read-the-spec technique `packages/runtime/src/spec-transcription.test.ts`
 * (W3-RT-01) uses for §14.2/§14.5/§15.1: locate the named heading, take its fenced block, and
 * parse *every* line the block actually contains into the derived set — never a fixed array typed
 * by hand and merely hoped to agree. W3-RT-01 failed round 1 on exactly the opposite shape (a
 * hand-typed comparison list sitting beside a parser that had already produced the full one); this
 * file is written so the same mistake is not available here — `readA12ScenarioNames` is the only
 * thing that knows how many lines there are or what they say, and its caller
 * (`tests/conformance/scenario-names.test.ts`) never repeats that count as a separate assumption.
 *
 * `tests/conformance/scenarios.ts` keeps its own ten `name` strings, one per
 * {@link import('./types.js').A12ScenarioId}, so that the harness never has to read
 * `docs/spec.md` at run time to know what it is testing. Those two lists are independent
 * transcriptions, and `scenario-names.test.ts` is what proves they still agree — the check this
 * module exists to make possible, not the check itself.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The repository root, resolved from this file's own location rather than `process.cwd()`. */
export const REPO_ROOT = path.resolve(HERE, '../..');
export const SPEC_PATH = path.join(REPO_ROOT, 'docs/spec.md');

const HEADING = '## A.12 Driver conformance tests';

/**
 * The markdown section under `heading` (matched by exact line text, not a prefix — A.12's heading
 * has no sibling this repository would want to match instead), up to the next heading of any
 * level.
 */
function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) {
    throw new Error(`docs/spec.md has no heading exactly ${JSON.stringify(heading)}.`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The single ` ```text ` fenced block under the heading. */
function fencedTextBlock(section: string): string {
  const match = /```text\r?\n([\s\S]*?)```/.exec(section);
  if (!match) {
    throw new Error(`No \`\`\`text fenced block found under ${JSON.stringify(HEADING)}.`);
  }
  return match[1] ?? '';
}

/**
 * Every scenario line in A.12's fenced block, in source order, with its leading `"✓ "` marker
 * stripped.
 *
 * ADR-0015: this ends on a positive assertion. A line that does not start with the checkmark
 * marker is not skipped as "probably a blank line or a comment" — it is named and the parse fails,
 * because a fenced block this reader cannot fully account for is a fenced block it must not claim
 * to have read (ADR-0031: a limit stated once, not narrowed by falling through).
 */
export function readA12ScenarioNames(specText: string): readonly string[] {
  const block = fencedTextBlock(extractSection(specText, HEADING));
  const lines = block
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error(`A.12's fenced block under ${JSON.stringify(HEADING)} has no lines at all.`);
  }
  const names: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('✓ ')) {
      throw new Error(
        `A.12's fenced block contains a line that is not a "✓ " scenario and this reader does ` +
          `not know how to classify it: ${JSON.stringify(line)}. Extend readA12ScenarioNames ` +
          'rather than skip it.',
      );
    }
    names.push(line.slice('✓ '.length).trim());
  }
  return names;
}

/** Convenience for callers that want the live file rather than a synthetic string. */
export function readA12ScenarioNamesFromSpecFile(): readonly string[] {
  return readA12ScenarioNames(readFileSync(SPEC_PATH, 'utf8'));
}
