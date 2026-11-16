'use client';
/**
 * `ResourceForm`: one labelled control per field (the field's `control`), checked in the browser
 * with the resource's own create or update schema before it is sent, and saved through the
 * resource's client (issue #1508). A server problem whose details name fields marks those fields;
 * any other problem is a form-level alert that says what happened and offers to try again.
 */
import { AttachmentChips } from '@indx-workspace/react';
import { useId, useMemo, useReducer, type FormEvent, type ReactNode } from 'react';

import type { DefinedResource, FieldMap } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import { resourceClient, ResourceProblemError, type ResourceClient } from './client.js';
import { problemMessage, type AppStrings } from './locale.js';
import { useDisplayContext, type ResourceDisplayProps } from './resource-cell.js';
import {
  checkDraft,
  controlsOf,
  draftOf,
  formReducer,
  initialForm,
  type ControlView,
  type FieldError,
  type FormState,
} from './resource-form-model.js';
import { shortId } from './resource-view-model.js';

/** The props of {@link ResourceForm}. */
export interface ResourceFormProps<F extends FieldMap> extends ResourceDisplayProps {
  readonly resource: DefinedResource<F>;
  /** The record to change; without one the form creates a record. */
  readonly record?: RecordOf<F> | undefined;
  /** The client of the resource's routes; one for the page's own origin when not given. */
  readonly client?: ResourceClient<F> | undefined;
  /** Called with the saved record, as the route answered it. */
  readonly onSaved?: ((record: RecordOf<F>) => void) | undefined;
  /** Where the cancel link goes; no cancel link when not given. */
  readonly cancelHref?: string | undefined;
  /** The display name of an attached file, by platform file id; its short id when not given. */
  readonly fileName?: ((id: string) => string) | undefined;
}

type DraftValue = string | boolean | readonly string[];

interface ControlProps {
  readonly control: ControlView;
  readonly id: string;
  readonly value: DraftValue;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly strings: AppStrings;
  readonly people: Readonly<Record<string, string>> | undefined;
  readonly fileName: (id: string) => string;
  readonly onChange: (value: DraftValue) => void;
}

function textOf(value: DraftValue): string {
  return typeof value === 'string' ? value : '';
}

function inputType(control: ControlView): string {
  if (control.control === 'number') return 'number';
  if (control.control !== 'picker') return 'text';
  return control.type === 'date' ? 'date' : 'datetime-local';
}

/** The attributes every control carries: its id, its description, and whether it is refused. */
interface ControlAria {
  readonly id: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': boolean;
  readonly 'aria-required': boolean;
}

/** A select of an enum's values, or of the people the page names. */
function SelectControl({
  props,
  aria,
}: {
  readonly props: ControlProps;
  readonly aria: ControlAria;
}): ReactNode {
  const { control, value, people, strings, onChange } = props;
  const options =
    control.control === 'select'
      ? control.options
      : Object.entries(people ?? {}).map(([principal, name]) => ({
          value: principal,
          label: name,
        }));
  return (
    <select
      {...aria}
      value={textOf(value)}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      {control.required && textOf(value).length > 0 ? null : (
        <option value="">{strings.noValue}</option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** One field's control, by the field's control kind. Every one is a native, labelled element. */
function FieldControl(props: ControlProps): ReactNode {
  const { control, id, value, describedBy, invalid, strings, people, fileName, onChange } = props;
  const aria: ControlAria = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': invalid,
    'aria-required': control.required,
  };
  switch (control.control) {
    case 'select':
      return <SelectControl props={props} aria={aria} />;
    case 'people':
      return people === undefined ? (
        <input
          {...aria}
          type="text"
          value={textOf(value)}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      ) : (
        <SelectControl props={props} aria={aria} />
      );
    case 'switch':
      return (
        <input
          {...aria}
          type="checkbox"
          role="switch"
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
      );
    case 'editor':
      return (
        <textarea
          {...aria}
          rows={6}
          value={textOf(value)}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    case 'uploader': {
      const ids = typeof value === 'object' ? value : [];
      return (
        <div
          id={id}
          role="group"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          className="aw-app-attachments"
        >
          <AttachmentChips
            items={ids.map((each) => ({ id: each, name: fileName(each) }))}
            removeLabel={strings.removeFile}
            onRemove={(removed) => {
              onChange(ids.filter((each) => each !== removed));
            }}
            classNames={{ chip: 'aw-app-chip', remove: 'aw-app-chip-remove' }}
          />
        </div>
      );
    }
    default:
      return (
        <input
          {...aria}
          type={inputType(control)}
          inputMode={control.control === 'money' ? 'decimal' : undefined}
          step={control.control === 'number' ? 'any' : undefined}
          min={control.min}
          max={control.max}
          maxLength={control.maxLength}
          value={textOf(value)}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
  }
}

function hintOf(control: ControlView, strings: AppStrings): string | null {
  if (control.control === 'tags') return strings.tagsHint;
  if (control.control === 'editor') return strings.richTextHint;
  return control.currency ?? null;
}

function errorText(error: FieldError, strings: AppStrings): string {
  return error === 'required' ? strings.fieldRequired : strings.fieldInvalid;
}

/**
 * A control's label, marked when required. The attachments are a group, not a form control, so
 * their label is the group's name (`aria-labelledby`) rather than a `<label for>`.
 */
function FieldLabel({
  control,
  id,
  strings,
}: {
  readonly control: ControlView;
  readonly id: string;
  readonly strings: AppStrings;
}): ReactNode {
  const text = (
    <>
      {control.label}
      {control.required ? <span className="aw-app-required"> {strings.required}</span> : null}
    </>
  );
  return control.control === 'uploader' ? (
    <span id={`${id}-label`} className="aw-app-label">
      {text}
    </span>
  ) : (
    <label htmlFor={id} id={`${id}-label`} className="aw-app-label">
      {text}
    </label>
  );
}

/**
 * The form-level alert: what went wrong, and the way on (try again, or fix the fields). Exported
 * for its markup test: a static render only ever sees the form's first state.
 */
export function FormAlert({
  state,
  strings,
}: {
  readonly state: FormState;
  readonly strings: AppStrings;
}): ReactNode {
  if (state.status !== 'failed') return null;
  return (
    <div className="aw-app-alert" role="alert">
      <p className="aw-app-alert-heading">{strings.saveFailed}</p>
      {state.problem === null ? (
        <p>{strings.checkFields}</p>
      ) : (
        <>
          <p>{problemMessage(strings, state.problem)}</p>
          <button type="submit" className="aw-app-button">
            {strings.retry}
          </button>
        </>
      )}
    </div>
  );
}

/** A form that creates a record, or changes `record`. */
export function ResourceForm<F extends FieldMap>(props: ResourceFormProps<F>): ReactNode {
  const { resource, record, labels, valueLabels, people, onSaved, cancelHref } = props;
  const { strings } = useDisplayContext(props);
  const client = useMemo(() => props.client ?? resourceClient(resource), [props.client, resource]);
  const [state, dispatch] = useReducer(formReducer, draftOf(resource, record), initialForm);
  const base = useId();
  const controls = controlsOf(resource, labels, valueLabels);
  const fileName = props.fileName ?? shortId;

  const saved = (value: RecordOf<F>): void => {
    dispatch({ type: 'saved' });
    onSaved?.(value);
  };
  const failed = (error: unknown): void => {
    const problem = error instanceof ResourceProblemError ? error : null;
    dispatch({
      type: 'failed',
      code: problem?.code ?? 'other',
      placement: { fields: problem?.fieldErrors ?? {}, form: problem?.formErrors ?? [] },
    });
  };
  /** Checks the draft and sends it, or answers the errors that keep it from being sent. */
  const send = (): Promise<RecordOf<F>> | Readonly<Record<string, FieldError>> => {
    if (record === undefined) {
      const check = checkDraft(resource, 'create', state.draft);
      return check.ok ? client.create(check.body) : check.errors;
    }
    const check = checkDraft(resource, 'update', state.draft);
    return check.ok ? client.update(record.id, check.body) : check.errors;
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (state.status === 'saving') return;
    const outcome = send();
    if (!(outcome instanceof Promise)) {
      dispatch({ type: 'refused', errors: outcome });
      return;
    }
    dispatch({ type: 'saving' });
    outcome.then(saved, failed);
  };

  return (
    <form
      className="aw-app-form"
      noValidate
      onSubmit={submit}
      aria-busy={state.status === 'saving'}
    >
      <FormAlert state={state} strings={strings} />
      {controls.map((control) => {
        const id = `${base}-${control.name}`;
        const error = state.errors[control.name];
        const hint = hintOf(control, strings);
        const describedBy = [
          hint === null ? null : `${id}-hint`,
          error === undefined ? null : `${id}-error`,
        ]
          .filter((each) => each !== null)
          .join(' ');
        return (
          <div key={control.name} className="aw-app-field" data-control={control.control}>
            <FieldLabel control={control} id={id} strings={strings} />
            <FieldControl
              control={control}
              id={id}
              value={state.draft[control.name] ?? ''}
              describedBy={describedBy.length > 0 ? describedBy : undefined}
              invalid={error !== undefined}
              strings={strings}
              people={people}
              fileName={fileName}
              onChange={(value) => {
                dispatch({ type: 'change', name: control.name, value });
              }}
            />
            {hint === null ? null : (
              <p id={`${id}-hint`} className="aw-app-hint">
                {hint}
              </p>
            )}
            {error === undefined ? null : (
              <p id={`${id}-error`} className="aw-app-field-error">
                {errorText(error, strings)}
              </p>
            )}
          </div>
        );
      })}
      <div className="aw-app-actions">
        <button
          type="submit"
          className="aw-app-button aw-app-primary"
          disabled={state.status === 'saving'}
        >
          {state.status === 'saving' ? strings.saving : strings.save}
        </button>
        {cancelHref === undefined ? null : (
          <a href={cancelHref} className="aw-app-button">
            {strings.cancel}
          </a>
        )}
      </div>
    </form>
  );
}
