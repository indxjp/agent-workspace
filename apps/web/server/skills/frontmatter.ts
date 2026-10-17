/**
 * A minimal reader for the `SKILL.md` frontmatter fields this task's API surfaces without a
 * database row: `name`, `description`, and `allowed-tools` (R-01 §8's frontmatter table; the note
 * under that table is explicit that the UI's "Allowed Tools" field is this hyphenated frontmatter
 * key, not the SDK's `allowedTools` runtime option). This module also exposes {@link
 * extractSkillInstructions}, which returns the Markdown body after the frontmatter fence — spec
 * §7's "Instructions" field for `GET /api/skills/:name` (round 2, B4).
 *
 * **This is not a YAML parser, and it does not claim to be one.** It reads exactly one shape — a
 * `---`-delimited block at the top of the file, one `key: value` pair per line, a bare scalar or a
 * quoted string as the value — and nothing else: no multi-line block scalars, no flow collections,
 * no anchors, no comments stripped mid-line. `docs/adr/W2-CP-04-skill-storage-keys.md` declares
 * this scope as a gap rather than a hidden limitation: a `SKILL.md` whose `description` uses a
 * block scalar (`description: |`) or a nested mapping renders as `undefined` here, not as a parse
 * error and not as mangled text. The same limit applies to `allowed-tools`: R-01 §8 says the value
 * may be "a space/comma string or YAML list" — this reader accepts only the single-line string form
 * (split on commas and/or whitespace) and never a multi-line YAML list (`allowed-tools:\n  - Read`),
 * which renders as `undefined` here for the same declared reason. The file the platform's own
 * `POST /api/skills/:name` composer would never emit either unsupported shape — the field reference
 * in R-01 §8 shows every value as a single-line scalar — but an imported skill authored by hand
 * might, and the byte-identical export path never routes through this module at all (it re-serves
 * the stored bytes verbatim), so a `SKILL.md` this module cannot fully read is still stored and
 * exported exactly as it was imported.
 *
 * `SKILL.md`'s bytes are decoded as UTF-8 **only** for this read — never re-encoded, never written
 * back, and never the value returned by `GET .../export`, which always re-serves the stored bytes.
 * A `SKILL.md` that is not valid UTF-8 (unusual, but not forbidden by spec §7) makes
 * {@link parseSkillFrontmatter} return `{}` and {@link extractSkillInstructions} return `null`
 * rather than throw: the file is still stored and exported byte-for-byte, and this module's
 * inability to summarise it does not touch storage or export at all.
 */

export interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  /** Parsed from the single-line string form of `allowed-tools` only — see the module header. */
  readonly allowedTools?: readonly string[];
}

/** The frontmatter block's raw lines (between the fences) and the body text after it. */
interface SplitSkillMd {
  readonly frontmatterLines: readonly string[];
  readonly hasFrontmatter: boolean;
  readonly body: string;
}

/**
 * Locate the `---`-delimited frontmatter fence in already-decoded text and split it from the body.
 * Shared by {@link parseSkillFrontmatter} and {@link extractSkillInstructions} so the two functions
 * can never disagree about where the frontmatter block ends.
 */
function splitSkillMd(text: string): SplitSkillMd {
  const withoutBom = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = withoutBom.split(/\r\n|\r|\n/);
  if ((lines[0] ?? '').trim() !== '---') {
    return { frontmatterLines: [], hasFrontmatter: false, body: withoutBom };
  }
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      end = index;
      break;
    }
  }
  if (end === -1) {
    return { frontmatterLines: [], hasFrontmatter: false, body: withoutBom };
  }
  return {
    frontmatterLines: lines.slice(1, end),
    hasFrontmatter: true,
    body: lines.slice(end + 1).join('\n'),
  };
}

/**
 * Split `allowed-tools`' single-line string form into individual tool names — R-01 §8: "space/comma
 * string ... e.g. `Read, Grep, Bash`". Never throws; an empty or whitespace-only value yields `[]`.
 */
function splitToolList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Strip one layer of matching `'…'` or `"…"` quotes, if the whole value is wrapped in them. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Read `name`, `description` and `allowed-tools` out of a `SKILL.md`'s leading frontmatter block.
 * `{}` for anything this reader does not recognise as that shape — never a throw, per this module's
 * header.
 */
export function parseSkillFrontmatter(skillMdBytes: Uint8Array): SkillFrontmatter {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(skillMdBytes);
  } catch {
    return {};
  }

  const { frontmatterLines, hasFrontmatter } = splitSkillMd(text);
  if (!hasFrontmatter) return {};

  let name: string | undefined;
  let description: string | undefined;
  let allowedTools: string[] | undefined;
  const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
  for (const line of frontmatterLines) {
    const match = pair.exec(line);
    if (match === null) continue;
    const key = match[1] as string;
    const value = unquote((match[2] ?? '').trim());
    if (key === 'name' && name === undefined) name = value;
    if (key === 'description' && description === undefined) description = value;
    if (key === 'allowed-tools' && allowedTools === undefined) allowedTools = splitToolList(value);
  }
  const result: { name?: string; description?: string; allowedTools?: readonly string[] } = {};
  if (name !== undefined) result.name = name;
  if (description !== undefined) result.description = description;
  if (allowedTools !== undefined) result.allowedTools = allowedTools;
  return result;
}

/**
 * Read a `SKILL.md`'s Markdown body — everything after the closing frontmatter fence, or the whole
 * decoded text when there is no recognised frontmatter block (the file is still a valid "Instructions"
 * document even without one). `null` only when the bytes are not valid UTF-8, mirroring
 * {@link parseSkillFrontmatter}'s own failure mode — never a throw, and never touching storage or the
 * byte-identical export path. Added for round 2, B4: spec §7's "Instructions" field on
 * `GET /api/skills/:name`.
 */
export function extractSkillInstructions(skillMdBytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(skillMdBytes);
  } catch {
    return null;
  }
  return splitSkillMd(text).body;
}
