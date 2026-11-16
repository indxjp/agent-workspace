import { requiredValue } from './invariants.mjs';
/* global console */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import path from 'node:path';
import { globsIntersect, splitTopLevel } from './globs.mjs';
import { REPO_ROOT, trackedFiles } from './repository.mjs';

// ── Parsing ownership declarations out of a wave workflow script ────────────────────────

const TASK_ID = /\b([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,3})\b/;

/** Tolerant reader for the JS object-literal subset used by an `ownership` manifest. */
class OwnershipLiteralReader {
  /** @param {string} source
   * @param {number} index */
  constructor(source, index) {
    this.source = source;
    this.index = index;
  }
  skipWhitespace() {
    for (;;) {
      while (this.index < this.source.length && /\s/.test(this.source.charAt(this.index)))
        this.index++;
      if (this.source.startsWith('//', this.index)) {
        while (this.index < this.source.length && this.source[this.index] !== '\n') this.index++;
      } else if (this.source.startsWith('/*', this.index)) {
        this.index = this.source.indexOf('*/', this.index) + 2;
      } else return;
    }
  }
  readString() {
    const quote = this.source[this.index++];
    let result = '';
    while (this.index < this.source.length && this.source[this.index] !== quote) {
      if (this.source[this.index] === '\\') {
        result += this.source[this.index + 1];
        this.index += 2;
      } else result += this.source[this.index++];
    }
    this.index++;
    return result;
  }
  readKey() {
    if (['"', "'", '`'].includes(this.source.charAt(this.index))) return this.readString();
    const match = /^[A-Za-z0-9_$]+/.exec(this.source.slice(this.index));
    if (!match) throw new Error(`unparsable key at ${this.index}`);
    this.index += match[0].length;
    return match[0];
  }
  /** @returns {import('./types.mjs').Literal[]} */
  readArray() {
    this.index++;
    const values = [];
    for (;;) {
      this.skipWhitespace();
      if (this.source[this.index] === ']') {
        this.index++;
        return values;
      }
      values.push(this.readValue());
      this.skipWhitespace();
      if (this.source[this.index] === ',') this.index++;
    }
  }
  /** @returns {{[key:string]:import('./types.mjs').Literal}} */
  readObject() {
    this.index++;
    /** @type {{[key:string]:import('./types.mjs').Literal}} */
    const properties = {};
    for (;;) {
      this.skipWhitespace();
      if (this.source[this.index] === '}') {
        this.index++;
        return properties;
      }
      const key = this.readKey();
      this.skipWhitespace();
      if (this.source[this.index] !== ':') throw new Error(`expected ':' at ${this.index}`);
      this.index++;
      properties[key] = this.readValue();
      this.skipWhitespace();
      if (this.source[this.index] === ',') this.index++;
    }
  }
  /** @returns {import('./types.mjs').Literal} */
  readValue() {
    this.skipWhitespace();
    const token = this.source.charAt(this.index);
    if (['"', "'", '`'].includes(token)) return this.readString();
    if (token === '[') return this.readArray();
    if (token === '{') return this.readObject();
    const match = /^[^,\]}\s]+/.exec(this.source.slice(this.index));
    if (!match) throw new Error(`unparsable value at ${this.index}`);
    this.index += match[0].length;
    return match[0];
  }
}
/** @param {string} source
 * @param {number} index */
function readLiteral(source, index) {
  return new OwnershipLiteralReader(source, index).readValue();
}

/**
 * Extract `{ level -> { taskId -> globs[] } }` from a wave workflow script, from an
 * `ownership`/`OWNS` object literal and from `// Owns <id>: <globs>` comments.
 */
/** @param {string} source
 * @returns {import('./types.mjs').OwnershipPlan} */
export function parsePlan(source) {
  /** @type {import('./types.mjs').OwnershipPlan} */
  const levels = new Map();
  /** @param {string} level @param {string} taskId @param {import('./types.mjs').Literal[]} globs */
  const add = (level, taskId, globs) => {
    let tasks = levels.get(level);
    if (tasks === undefined) {
      tasks = new Map();
      levels.set(level, tasks);
    }
    const prev = tasks.get(taskId) ?? [];
    tasks.set(taskId, [...prev, ...globs]);
  };

  const decl = /(?:export\s+)?const\s+(?:ownership|OWNS)\s*=\s*/.exec(source);
  if (decl) {
    const literal = readLiteral(source, decl.index + decl[0].length);
    for (const [level, tasks] of Object.entries(typeof literal === 'string' ? {} : literal)) {
      if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) continue;
      for (const [taskId, globs] of Object.entries(tasks)) {
        const values = Array.isArray(globs) ? globs : [globs];
        add(level, taskId, values);
      }
    }
  }

  let level = 'default';
  for (const line of source.split('\n')) {
    const ph = /\bphase\(\s*['"`]([^'"`]+)['"`]/.exec(line);
    if (ph) level = requiredValue(ph[1], 'phase name capture exists');
    const m = /^\s*\/\/\s*Owns\s*(?:\[([^\]]+)\])?\s*([^:]*?)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const id = TASK_ID.exec(m[2] ?? '')?.[1];
    if (!id) continue;
    // splitTopLevel, not split(','), so `// Owns X: apps/{web,runner}/**` stays one glob.
    const globs = splitTopLevel(requiredValue(m[3], 'ownership globs capture exists'))
      .map((s) => s.trim())
      .filter(Boolean);
    if (globs.length) add(m[1]?.trim() || level, id, globs);
  }
  return levels;
}

// ── Modes ───────────────────────────────────────────────────────────────────────────────

/** @param {string} file
 * @param {string[]} files */
function checkPlanFile(file, files) {
  const rel = (path.relative(REPO_ROOT, path.resolve(file)) || file).split(path.sep).join('/');
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`FAIL ${rel}: cannot read (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
  const levels = parsePlan(source);
  if (levels.size === 0) {
    console.log(`warn ${rel}: no ownership declarations found — nothing to check.`);
    console.log(
      '     Declare `export const ownership = { <level>: { <task-id>: [<globs>] } }` or ' +
        '`// Owns <task-id>: <globs>` so §2.3 can be enforced.',
    );
    return 0;
  }

  let failures = 0;
  for (const [level, tasks] of levels) {
    const entries = [...tasks];
    const ids = entries.map(([id]) => id);
    console.log(`  level ${level}: ${ids.length} task(s) — ${ids.join(', ')}`);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [leftId, leftGlobs] = requiredValue(entries[i], 'left task index is in bounds');
        const [rightId, rightGlobs] = requiredValue(entries[j], 'right task index is in bounds');
        failures += checkTaskPair({
          rel,
          level,
          leftId,
          rightId,
          leftGlobs,
          rightGlobs,
          files,
        });
      }
    }
  }
  if (failures === 0) console.log(`ok   ${rel}: all parallel levels have disjoint ownership.`);
  return failures ? 1 : 0;
}

/** @param {string[]} args */
export function planMode(args) {
  const files = trackedFiles();
  let targets = args.filter((a) => !a.startsWith('-'));
  if (targets.length === 0) {
    const dir = path.join(REPO_ROOT, '.claude', 'workflows');
    if (!existsSync(dir)) {
      console.log('No .claude/workflows/ directory yet — no wave scripts to check.');
      return 0;
    }
    targets = readdirSync(dir)
      .filter((f) => /\.(mjs|js)$/.test(f))
      .map((f) => path.join(dir, f));
    if (targets.length === 0) {
      console.log('.claude/workflows/ contains no wave scripts — nothing to check.');
      return 0;
    }
  }
  console.log(`Ownership plan check over ${targets.length} script(s):`);
  return targets.reduce((code, f) => Math.max(code, checkPlanFile(f, files)), 0);
}

/** @param {{rel:string,level:string,leftId:string,rightId:string,leftGlobs:import('./types.mjs').Literal[],rightGlobs:import('./types.mjs').Literal[],files:string[]}} pair */
function checkTaskPair({ rel, level, leftId, rightId, leftGlobs, rightGlobs, files }) {
  let failures = 0;
  for (const ga of leftGlobs) {
    for (const gb of rightGlobs) {
      const r = globsIntersect(ga, gb, files);
      if (r.intersects) {
        failures++;
        console.error(
          `FAIL ${rel} [${level}]: ${leftId} "${ga}" intersects ${rightId} "${gb}" ` +
            `(${r.reason}: ${r.evidence.join(', ')})`,
        );
      }
    }
  }
  return failures;
}
