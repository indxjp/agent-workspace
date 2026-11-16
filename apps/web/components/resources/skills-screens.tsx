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

function SkillRow({ name, enabled }: { name: string; enabled: boolean }) {
  return (
    <div className="flex items-center gap-3 border-b border-border py-3 last:border-0">
      <Link
        className="flex-1 text-sm font-medium text-accent"
        href={`/skills/${encodeURIComponent(name)}`}
      >
        {name}
      </Link>
      <span className="text-xs text-muted">{enabled ? 'Enabled' : 'Disabled'}</span>
    </div>
  );
}

export function SkillsScreen() {
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
    <>
      {title('Skills', 'Create and manage private workspace skills.')}
      <Status problem={state.problem} />
      {state.loading ? (
        <p className="mb-4 text-sm text-muted" role="status">
          Loading skills…
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
        <input className={INPUT} name="description" placeholder="What this skill does" required />
        <textarea
          className={INPUT}
          name="instructions"
          placeholder="Instructions"
          required
          rows={4}
        />
        <button className={BUTTON} type="submit">
          Create skill
        </button>
      </form>
      <div className={CARD}>
        {rowsWithStrings(state.value, 'skills', 'name').map((skill) => (
          <SkillRow enabled={skill['enabled'] !== false} key={skill.name} name={skill.name} />
        ))}
        {state.value !== null && rows(state.value, 'skills').length === 0 ? (
          <p className="text-sm text-muted">No skills yet.</p>
        ) : null}
      </div>
    </>
  );
}

/** Each object in `items`, formatted and comma-joined; `none` when `items` is not a list. */
function listField(items: unknown, format: (item: Row) => string): string {
  if (!Array.isArray(items)) return 'none';
  const objects = items.filter((item): item is Row => typeof item === 'object' && item !== null);
  return objects.map(format).filter(Boolean).join(', ');
}

/** `items` when it is a list with something in it, else `null`. */
function nonEmptyList(items: unknown): unknown {
  return Array.isArray(items) && items.length > 0 ? items : null;
}

/** The read-only part of a skill's detail: its supporting files and its published revisions. */
function SkillFilesAndRevisions({ detail }: { detail: Row }) {
  return (
    <>
      <div className="text-xs text-muted">
        Supporting files: {listField(detail['files'], (file) => display(file['path']))}
      </div>
      <div className="text-xs text-muted">
        Published revisions (newest first; publish with <code>aw skills publish</code>):{' '}
        {listField(
          nonEmptyList(detail['revisions']),
          (revision) => `#${display(revision['number'])}`,
        )}
      </div>
    </>
  );
}

export function SkillDetailScreen({ name }: { name: string }) {
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
    <>
      {title(
        name,
        'Skill manifest and installed files.',
        <Link className={BUTTON} href="/skills">
          Back
        </Link>,
      )}
      <Status problem={state.problem} />
      {state.loading ? (
        <p className="text-sm text-muted" role="status">
          Loading skill…
        </p>
      ) : null}
      {detail === null ? null : (
        <form className={`${CARD} grid gap-3`} onSubmit={submitHandler(save, state.setProblem)}>
          <label className="grid gap-1 text-sm">
            Description
            <input
              className={INPUT}
              defaultValue={display(detail['description'])}
              name="description"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Instructions
            <textarea
              className={INPUT}
              defaultValue={display(detail['instructions'])}
              name="instructions"
              rows={10}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input defaultChecked={detail['enabled'] !== false} name="enabled" type="checkbox" />{' '}
            Enabled
          </label>
          <SkillFilesAndRevisions detail={detail} />
          <button className={BUTTON} type="submit">
            Save changes
          </button>
        </form>
      )}
    </>
  );
}
