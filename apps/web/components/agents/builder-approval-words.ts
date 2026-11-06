import { revealInvisible, type DefinitionChange } from '@indx-workspace/sdk/portable';

import { PERMISSION_CHOICES } from './agent-form';

/**
 * One change on the approval card in words: what it is (`label`) and what it becomes (`value`).
 * Every name the model wrote is shown with {@link revealInvisible}, so two that differ only by an
 * invisible character still read differently. A path this file does not know is shown as itself.
 */
export interface ChangeInWords {
  readonly label: string;
  readonly value: string;
}

/** Fields that hold one value, by exact path. */
const FIELDS: ReadonlyMap<string, string> = new Map([
  ['definition.agent.instructions', 'Instructions'],
  ['definition.agent.model', 'Model'],
  ['definition.agent.modelConnectionName', 'Model connection'],
  ['definition.agent.runtimeProfileName', 'Runtime profile'],
  ['definition.policy.tools.base', 'Tool set'],
  ['definition.policy.tools.permissionMode', 'Permission mode'],
  ['definition.policy.tools.allowDangerouslySkipPermissions', 'Skip permission checks'],
  ['description', 'Description'],
]);

/** One quoted name in a path, exactly as `JSON.stringify` writes it. */
const NAME = String.raw`("(?:[^"\\]|\\.)*")`;

/** A pattern that must match the whole path. */
function entry(source: string): RegExp {
  return new RegExp(`^${source}$`, 'u');
}

/**
 * Each path that names list entries, as a pattern over the whole path, and its label from those
 * names. A name is a whole JSON string, so `skills["n"].revision` never matches `skills["n"]`.
 */
const ENTRIES: readonly (readonly [
  pattern: RegExp,
  label: (names: readonly string[]) => string,
])[] = [
  [
    entry(String.raw`definition\.resources\.files\[${NAME}\]#(\d+)`),
    ([path, repeat]) => `File access: ${path} (entry ${repeat})`,
  ],
  [entry(String.raw`definition\.resources\.files\[${NAME}\]`), ([path]) => `File access: ${path}`],
  [
    entry(String.raw`definition\.resources\.skills\[${NAME}\]\.revision`),
    ([name]) => `Skill version: ${name}`,
  ],
  [entry(String.raw`definition\.resources\.skills\[${NAME}\]`), ([name]) => `Skill: ${name}`],
  [
    entry(String.raw`definition\.resources\.connectors\[${NAME}\]`),
    ([name]) => `Connector: ${name}`,
  ],
  [
    entry(String.raw`definition\.policy\.tools\.base\[${NAME}\]`),
    ([rule]) => `Tool in the tool set: ${rule}`,
  ],
  [
    entry(String.raw`definition\.policy\.tools\.deny\[${NAME}\]`),
    ([rule]) => `Blocked tool: ${rule}`,
  ],
  [
    entry(String.raw`definition\.policy\.tools\.autoApprove\[${NAME}\]`),
    ([rule]) => `Used without asking: ${rule}`,
  ],
  [
    entry(String.raw`toolBundles\[${NAME}\]\.timeoutMs`),
    ([tool]) => `Code tool timeout (ms): ${tool}`,
  ],
  [
    entry(String.raw`toolBundles\[${NAME}\]\.allowedDomains\[${NAME}\]`),
    ([tool, host]) => `Code tool ${tool} may reach: ${host}`,
  ],
  [
    entry(String.raw`toolBundles\[${NAME}\]\.secrets\[${NAME}\]`),
    ([tool, secret]) => `Code tool ${tool} uses secret: ${secret}`,
  ],
  [entry(String.raw`toolBundles\[${NAME}\]`), ([tool]) => `Code tool: ${tool}`],
  [entry(String.raw`subagents\[${NAME}\]`), ([name]) => `Subagent: ${name}`],
  [entry(String.raw`knowledge\.files\[${NAME}\]`), ([path]) => `Knowledge file: ${path}`],
  [entry(String.raw`knowledge\.connectors\[${NAME}\]`), ([name]) => `Knowledge connector: ${name}`],
];

const PERMISSION_PREFIX = 'definition.agent.permissions.';
/** What `null` means for a field: the contract leaves the choice to the deployment or workspace. */
const DEFAULT_WHEN_NULL: ReadonlyMap<string, string> = new Map([
  ['definition.agent.model', 'Deployment default'],
  ['definition.agent.modelConnectionName', 'Deployment default'],
  ['definition.agent.runtimeProfileName', 'Workspace default'],
]);

/**
 * A name as the label shows it. A name with space at either end, or none at all, stays quoted, so
 * `"crm "` never reads as `crm`; every invisible character is shown by its code.
 */
function nameText(name: string): string {
  const shown = name === '' || name.trim() !== name ? JSON.stringify(name) : name;
  return revealInvisible(shown);
}

/** A quoted name read back, or `null` when it is not a JSON string. */
function quotedName(quoted: string): string | null {
  try {
    const name: unknown = JSON.parse(quoted);
    return typeof name === 'string' ? nameText(name) : null;
  } catch {
    return null;
  }
}

/** The entry's label, or `null` when the path names no list entry this file knows. */
function entryLabel(path: string): string | null {
  for (const [pattern, label] of ENTRIES) {
    const match = pattern.exec(path);
    if (match === null) continue;
    const names: string[] = [];
    for (const part of match.slice(1)) {
      const name = /^\d+$/u.test(part) ? part : quotedName(part);
      if (name === null) return null;
      names.push(name);
    }
    return label(names);
  }
  return null;
}

/** A field's value in words; strings stay quoted exactly as written. */
function fieldValue(path: string, value: unknown): string {
  if (value === undefined) return 'None';
  if (value === null) return DEFAULT_WHEN_NULL.get(path) ?? 'None';
  if (value === 'claude_code_preset') return 'Claude Code preset';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return revealInvisible(JSON.stringify(value) ?? 'None');
}

function permissionValue(value: unknown): string {
  if (value === undefined) return 'None';
  return value === true ? 'Allowed' : 'Not allowed';
}

/** A list entry's value in words: file access by its level, anything else as a field. */
function entryWord(path: string, value: unknown): string {
  if (value === 'read') return 'Read only';
  if (value === 'read-write') return 'Read and write';
  return fieldValue(path, value);
}

/** A list entry: added (with its value, when it has one), removed, or what it changed from and to. */
function entryValue(change: DefinitionChange): string {
  const before = 'before' in change ? change.before : undefined;
  if (change.after === undefined) return 'Removed';
  if (before === undefined) {
    return change.after === true ? 'Added' : `Added: ${entryWord(change.path, change.after)}`;
  }
  return `${entryWord(change.path, before)} → ${entryWord(change.path, change.after)}`;
}

function changed(before: string | undefined, after: string): string {
  return before === undefined || before === after ? after : `${before} → ${after}`;
}

export function changeInWords(change: DefinitionChange): ChangeInWords {
  const { path } = change;
  const before = 'before' in change ? change.before : undefined;
  const isNew = !('before' in change);
  if (path.startsWith(PERMISSION_PREFIX)) {
    const key = path.slice(PERMISSION_PREFIX.length);
    const choice = PERMISSION_CHOICES.find(([permission]) => permission === key);
    if (choice !== undefined) {
      return {
        label: choice[1],
        value: changed(isNew ? undefined : permissionValue(before), permissionValue(change.after)),
      };
    }
  }
  const field = FIELDS.get(path);
  if (field !== undefined) {
    return {
      label: field,
      value: changed(isNew ? undefined : fieldValue(path, before), fieldValue(path, change.after)),
    };
  }
  const label = entryLabel(path);
  if (label !== null) return { label, value: entryValue(change) };
  return {
    label: revealInvisible(path),
    value: changed(isNew ? undefined : fieldValue(path, before), fieldValue(path, change.after)),
  };
}
