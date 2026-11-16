import { revealInvisible, type DefinitionChange } from '@indx-workspace/sdk/portable';

import { permissionChoices } from './agent-form';
import { builderStrings, type ChangeWords } from './builder-messages';
import { newAgentStrings, type AgentStepWords } from './new-agent-messages';
import type { VersionsLocale } from './versions-messages';

/**
 * One change on the approval card in words: what it is (`label`) and what it becomes (`value`).
 * Every name the model wrote is shown with {@link revealInvisible}, so two that differ only by an
 * invisible character still read differently. A path this file does not know is shown as itself.
 */
export interface ChangeInWords {
  readonly label: string;
  readonly value: string;
}

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
function entries(
  words: ChangeWords,
): readonly (readonly [pattern: RegExp, label: (names: readonly string[]) => string])[] {
  // Every pattern takes the names it captures in order; a missing one reads as empty.
  const at = (names: readonly string[], index: number): string => names[index] ?? '';
  return [
    [
      entry(String.raw`definition\.resources\.files\[${NAME}\]#(\d+)`),
      (names) => words.fileAccessEntry(at(names, 0), at(names, 1)),
    ],
    [
      entry(String.raw`definition\.resources\.files\[${NAME}\]`),
      (names) => words.fileAccess(at(names, 0)),
    ],
    [
      entry(String.raw`definition\.resources\.skills\[${NAME}\]\.revision`),
      (names) => words.skillVersion(at(names, 0)),
    ],
    [
      entry(String.raw`definition\.resources\.skills\[${NAME}\]`),
      (names) => words.skill(at(names, 0)),
    ],
    [
      entry(String.raw`definition\.resources\.connectors\[${NAME}\]`),
      (names) => words.connector(at(names, 0)),
    ],
    [
      entry(String.raw`definition\.policy\.tools\.base\[${NAME}\]`),
      (names) => words.toolInSet(at(names, 0)),
    ],
    [
      entry(String.raw`definition\.policy\.tools\.deny\[${NAME}\]`),
      (names) => words.blockedTool(at(names, 0)),
    ],
    [
      entry(String.raw`definition\.policy\.tools\.autoApprove\[${NAME}\]`),
      (names) => words.usedWithoutAsking(at(names, 0)),
    ],
    [
      entry(String.raw`toolBundles\[${NAME}\]\.timeoutMs`),
      (names) => words.codeToolTimeout(at(names, 0)),
    ],
    [
      entry(String.raw`toolBundles\[${NAME}\]\.allowedDomains\[${NAME}\]`),
      (names) => words.codeToolMayReach(at(names, 0), at(names, 1)),
    ],
    [
      entry(String.raw`toolBundles\[${NAME}\]\.secrets\[${NAME}\]`),
      (names) => words.codeToolSecret(at(names, 0), at(names, 1)),
    ],
    [entry(String.raw`toolBundles\[${NAME}\]`), (names) => words.codeTool(at(names, 0))],
    [entry(String.raw`subagents\[${NAME}\]`), (names) => words.subagent(at(names, 0))],
    [entry(String.raw`knowledge\.files\[${NAME}\]`), (names) => words.knowledgeFile(at(names, 0))],
    [
      entry(String.raw`knowledge\.connectors\[${NAME}\]`),
      (names) => words.knowledgeConnector(at(names, 0)),
    ],
  ];
}

const PERMISSION_PREFIX = 'definition.agent.permissions.';
/** The fields where `null` means the contract leaves the choice to the deployment or workspace. */
const DEPLOYMENT_WHEN_NULL: ReadonlySet<string> = new Set([
  'definition.agent.model',
  'definition.agent.modelConnectionName',
]);
const WORKSPACE_WHEN_NULL = 'definition.agent.runtimeProfileName';

/** Words for a change, and the patterns built from them; one per language, built once. */
interface Vocabulary {
  readonly words: ChangeWords;
  readonly steps: AgentStepWords;
  readonly entries: ReturnType<typeof entries>;
}

const VOCABULARIES = new Map<VersionsLocale, Vocabulary>();

function vocabulary(locale: VersionsLocale): Vocabulary {
  const known = VOCABULARIES.get(locale);
  if (known !== undefined) return known;
  const words = builderStrings(locale).change;
  const built: Vocabulary = { words, steps: newAgentStrings(locale), entries: entries(words) };
  VOCABULARIES.set(locale, built);
  return built;
}

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
function entryLabel(path: string, known: Vocabulary['entries']): string | null {
  for (const [pattern, label] of known) {
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
function fieldValue(path: string, value: unknown, words: ChangeWords): string {
  if (value === undefined) return words.none;
  if (value === null) {
    if (DEPLOYMENT_WHEN_NULL.has(path)) return words.deploymentDefault;
    return path === WORKSPACE_WHEN_NULL ? words.workspaceDefault : words.none;
  }
  if (value === 'claude_code_preset') return words.claudeCodePreset;
  if (typeof value === 'boolean') return value ? words.yes : words.no;
  return revealInvisible(JSON.stringify(value) ?? words.none);
}

function permissionValue(value: unknown, words: ChangeWords): string {
  if (value === undefined) return words.none;
  return value === true ? words.allowed : words.notAllowed;
}

/** A list entry's value in words: file access by its level, anything else as a field. */
function entryWord(path: string, value: unknown, words: ChangeWords): string {
  if (value === 'read') return words.readOnly;
  if (value === 'read-write') return words.readAndWrite;
  return fieldValue(path, value, words);
}

/** A list entry: added (with its value, when it has one), removed, or what it changed from and to. */
function entryValue(change: DefinitionChange, words: ChangeWords): string {
  const before = 'before' in change ? change.before : undefined;
  if (change.after === undefined) return words.removed;
  if (before === undefined) {
    return change.after === true
      ? words.added
      : words.addedValue(entryWord(change.path, change.after, words));
  }
  return `${entryWord(change.path, before, words)} → ${entryWord(change.path, change.after, words)}`;
}

function changed(before: string | undefined, after: string): string {
  return before === undefined || before === after ? after : `${before} → ${after}`;
}

/** One change in the reader's words; English when no locale is given. */
export function changeInWords(
  change: DefinitionChange,
  locale: VersionsLocale = 'en',
): ChangeInWords {
  const { words, steps, entries: known } = vocabulary(locale);
  const { path } = change;
  const before = 'before' in change ? change.before : undefined;
  const isNew = !('before' in change);
  if (path.startsWith(PERMISSION_PREFIX)) {
    const key = path.slice(PERMISSION_PREFIX.length);
    const choice = permissionChoices(steps).find(([permission]) => permission === key);
    if (choice !== undefined) {
      return {
        label: choice[1],
        value: changed(
          isNew ? undefined : permissionValue(before, words),
          permissionValue(change.after, words),
        ),
      };
    }
  }
  // Own keys only: a path such as `constructor` must not find an inherited property.
  const field = Object.hasOwn(words.fields, path) ? words.fields[path] : undefined;
  if (field !== undefined) {
    return {
      label: field,
      value: changed(
        isNew ? undefined : fieldValue(path, before, words),
        fieldValue(path, change.after, words),
      ),
    };
  }
  const label = entryLabel(path, known);
  if (label !== null) return { label, value: entryValue(change, words) };
  return {
    label: revealInvisible(path),
    value: changed(
      isNew ? undefined : fieldValue(path, before, words),
      fieldValue(path, change.after, words),
    ),
  };
}
