'use client';

import Link from 'next/link';
import { useCallback, type FormEvent } from 'react';
import { browserClient } from '../../lib/browser-client';
import {
  createSkill,
  errorText,
  loadSkill,
  loadSkills,
  saveSkill,
  type ResourcesClient,
} from './resources-model';
import {
  display,
  formString,
  rows,
  rowsWithStrings,
  Status,
  title,
  useJson,
} from './resource-screen-state';
import { BUTTON, CARD, INPUT } from './resource-styles';
import { updateSkillSource } from './skill-source';
import type { VersionsLocale } from '../agents/versions-messages';
import { skillsStrings, type SkillDetailStrings, type SkillsStrings } from './skills-messages';

export { updateSkillSource };

type Row = Record<string, unknown>;

/** Runs a form action and reports its failure on the screen instead of leaving it unhandled. */
function submitHandler(
  action: (event: FormEvent<HTMLFormElement>) => Promise<void>,
  onProblem: (message: string) => void,
): (event: FormEvent<HTMLFormElement>) => void {
  return (event) => void action(event).catch((error: unknown) => onProblem(errorText(error)));
}

/** The description and instructions both skill forms ask for, trimmed. */
function skillFields(form: FormData): { description: string; instructions: string } {
  return {
    description: formString(form, 'description').trim(),
    instructions: formString(form, 'instructions').trim(),
  };
}

function SkillRow({
  name,
  enabled,
  strings,
}: {
  name: string;
  enabled: boolean;
  strings: SkillsStrings;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border py-3 last:border-0">
      <Link
        className="flex-1 text-sm font-medium text-accent"
        href={`/skills/${encodeURIComponent(name)}`}
      >
        {name}
      </Link>
      <span className="text-xs text-muted">{enabled ? strings.enabled : strings.disabled}</span>
    </div>
  );
}

export function SkillsScreen({ locale = 'en' }: { readonly locale?: VersionsLocale }) {
  const strings = skillsStrings(locale);
  const state = useJson(loadSkills);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const name = formString(form, 'name').trim();
    const { description, instructions } = skillFields(form);
    const source = updateSkillSource('', name, description, instructions);
    await createSkill(browserClient(), name, source);
    element.reset();
    await state.reload();
  };
  return (
    <div lang={locale}>
      {title(strings.title, strings.intro)}
      <Status problem={state.problem} />
      {state.loading ? (
        <p className="mb-4 text-sm text-muted" role="status">
          {strings.loading}
        </p>
      ) : null}
      <form
        className={`${CARD} mb-5 grid gap-3`}
        onSubmit={submitHandler(create, state.setProblem)}
      >
        <input
          className={INPUT}
          name="name"
          pattern="[a-z0-9-]+"
          placeholder="skill-name"
          required
        />
        <input
          className={INPUT}
          name="description"
          placeholder={strings.descriptionPlaceholder}
          required
        />
        <textarea
          className={INPUT}
          name="instructions"
          placeholder={strings.instructionsPlaceholder}
          required
          rows={4}
        />
        <button className={BUTTON} type="submit">
          {strings.createSkill}
        </button>
      </form>
      <div className={CARD}>
        {rowsWithStrings(state.value, 'skills', 'name').map((skill) => (
          <SkillRow
            enabled={skill['enabled'] !== false}
            key={skill.name}
            name={skill.name}
            strings={strings}
          />
        ))}
        {state.value !== null && rows(state.value, 'skills').length === 0 ? (
          <p className="text-sm text-muted">{strings.empty}</p>
        ) : null}
      </div>
    </div>
  );
}

/** Each object in `items`, formatted and comma-joined; `none` when `items` is not a list. */
function listField(items: unknown, format: (item: Row) => string, none: string): string {
  if (!Array.isArray(items)) return none;
  const objects = items.filter((item): item is Row => typeof item === 'object' && item !== null);
  return objects.map(format).filter(Boolean).join(', ');
}

/** `items` when it is a list with something in it, else `null`. */
function nonEmptyList(items: unknown): unknown {
  return Array.isArray(items) && items.length > 0 ? items : null;
}

/** The read-only part of a skill's detail: its supporting files and its published revisions. */
function SkillFilesAndRevisions({ detail, words }: { detail: Row; words: SkillDetailStrings }) {
  return (
    <>
      <div className="text-xs text-muted">
        {words.supportingFiles}{' '}
        {listField(detail['files'], (file) => display(file['path']), words.none)}
      </div>
      <div className="text-xs text-muted">
        {words.revisionsBefore}
        <code>aw skills publish</code>
        {words.revisionsAfter}{' '}
        {listField(
          nonEmptyList(detail['revisions']),
          (revision) => `#${display(revision['number'])}`,
          words.none,
        )}
      </div>
    </>
  );
}

export function SkillDetailScreen({
  name,
  locale = 'en',
}: {
  readonly name: string;
  /** The reader's language (UX-15 in #2086); English by default. */
  readonly locale?: VersionsLocale;
}) {
  const words = skillsStrings(locale).detail;
  const state = useJson(useCallback((client: ResourcesClient) => loadSkill(client, name), [name]));
  const skill = state.value?.['skill'];
  const detail = typeof skill === 'object' && skill !== null ? (skill as Row) : null;
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const enabled = form.get('enabled') === 'on';
    const { description, instructions } = skillFields(form);
    const source = updateSkillSource(display(detail?.['source']), name, description, instructions);
    await saveSkill(browserClient(), name, enabled, source);
    await state.reload();
  };
  return (
    <div lang={locale}>
      {title(
        name,
        words.intro,
        <Link className={BUTTON} href="/skills">
          {words.back}
        </Link>,
      )}
      <Status problem={state.problem} />
      {state.loading ? (
        <p className="text-sm text-muted" role="status">
          {words.loading}
        </p>
      ) : null}
      {detail === null ? null : (
        <form className={`${CARD} grid gap-3`} onSubmit={submitHandler(save, state.setProblem)}>
          <label className="grid gap-1 text-sm">
            {words.description}
            <input
              className={INPUT}
              defaultValue={display(detail['description'])}
              name="description"
            />
          </label>
          <label className="grid gap-1 text-sm">
            {words.instructions}
            <textarea
              className={INPUT}
              defaultValue={display(detail['instructions'])}
              name="instructions"
              rows={10}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input defaultChecked={detail['enabled'] !== false} name="enabled" type="checkbox" />{' '}
            {words.enabled}
          </label>
          <SkillFilesAndRevisions detail={detail} words={words} />
          <button className={BUTTON} type="submit">
            {words.saveChanges}
          </button>
        </form>
      )}
    </div>
  );
}
