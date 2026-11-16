/**
 * A skill's `SKILL.md` source: the YAML frontmatter the skill screens edit, written back with the
 * name and description replaced and the instructions body swapped.
 */

const YAML_WORDS = /^(?:true|false|null|yes|no|on|off|y|n)$/iu;

/**
 * A frontmatter value as a YAML scalar: plain when that reads back as the same string, else a
 * double-quoted scalar (a JSON string is one), so a colon, `#`, quote, leading symbol or newline in
 * a description cannot break or change the frontmatter.
 */
function yamlScalar(value: string): string {
  const plain = /^[A-Za-z][\w .,()/-]*$/u.test(value) && !YAML_WORDS.test(value);
  return plain && value === value.trimEnd() ? value : JSON.stringify(value);
}

/** The lines between the `---` fences of `source`, or `null` when it has no frontmatter. */
function frontmatterLines(lines: readonly string[]): string[] | null {
  if ((lines[0] ?? '').trim() !== '---') return null;
  const end = lines.slice(1).findIndex((line) => line.trim() === '---');
  return end < 0 ? null : lines.slice(1, end + 1);
}

/**
 * Sets `key` in the frontmatter lines, in place: replaces its entry (and the indented lines of a
 * block or folded scalar that continued it), or appends one when the key is absent.
 */
function setFrontmatterEntry(frontmatter: string[], key: string, value: string): void {
  const index = frontmatter.findIndex((line) => new RegExp(`^${key}\\s*:`, 'u').test(line));
  const entry = `${key}: ${yamlScalar(value)}`;
  if (index < 0) {
    frontmatter.push(entry);
    return;
  }
  let next = index + 1;
  while (next < frontmatter.length && /^[ \t]/u.test(frontmatter[next] ?? '')) next += 1;
  frontmatter.splice(index, next - index, entry);
}

function skillDocument(frontmatter: string, instructions: string): string {
  return `---\n${frontmatter}\n---\n\n${instructions}\n`;
}

/** `current` with its name, description and instructions replaced; a source with no frontmatter gets one. */
export function updateSkillSource(
  current: string,
  name: string,
  description: string,
  instructions: string,
): string {
  const frontmatter = frontmatterLines(current.split(/\r\n|\r|\n/u));
  if (frontmatter === null) {
    return skillDocument(
      `name: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}`,
      instructions,
    );
  }
  setFrontmatterEntry(frontmatter, 'name', name);
  setFrontmatterEntry(frontmatter, 'description', description);
  return skillDocument(frontmatter.join('\n'), instructions);
}
