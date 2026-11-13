/**
 * What the resource form edits and how it checks it, derived from a `defineResource` result alone
 * (issue #1508). Pure, with no React: one control per field (the field's `control`), the draft
 * the controls hold as strings, the conversion of a draft into the create or update body, the
 * client-side check with the same Zod schema the route uses, and the form's state machine.
 */
import type { z } from 'zod';

import type { AnyField, ControlKind, FieldType } from '../fields/types.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import {
  createInputSchema,
  updateInputSchema,
  type CreateInput,
  type UpdateInput,
} from '../schemas.js';
import {
  enumValues,
  fieldLabel,
  fieldValue,
  valueLabel,
  type FieldLabels,
  type ProblemPlacement,
  type RecordValues,
  type ValueLabels,
} from './resource-view-model.js';

/** Whether the form makes a record or changes one. */
export type FormMode = 'create' | 'update';

/** One control of the form. */
export interface ControlView {
  readonly name: string;
  readonly label: string;
  readonly type: FieldType;
  readonly control: ControlKind;
  /** Whether the field must have a value (it is not `optional`). */
  readonly required: boolean;
  /** The choices of a `select` control, in the enum's order. */
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /** A `text()` field's `max`, a `number()` field's bounds, a `money()` field's currency. */
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly currency?: string;
}

function numberOption(field: AnyField, key: string): number | undefined {
  const value = field.options[key];
  return typeof value === 'number' ? value : undefined;
}

function boundsOf(field: AnyField): Pick<ControlView, 'maxLength' | 'min' | 'max' | 'currency'> {
  const max = numberOption(field, 'max');
  const min = numberOption(field, 'min');
  const currency = field.options['currency'];
  if (field.type === 'text') return max === undefined ? {} : { maxLength: max };
  if (field.type === 'number') {
    return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  }
  return field.type === 'money' && typeof currency === 'string' ? { currency } : {};
}

/** One control per field, in the order the resource defines them. */
export function controlsOf(
  resource: DefinedResource,
  labels?: FieldLabels,
  valueLabels?: ValueLabels,
): readonly ControlView[] {
  return Object.entries(resource.fields).map(([name, field]) => ({
    name,
    label: fieldLabel(name, labels),
    type: field.type,
    control: field.control,
    required: !field.optional,
    options: enumValues(field).map((value) => ({
      value,
      label: valueLabel(name, value, valueLabels),
    })),
    ...boundsOf(field),
  }));
}

/**
 * What the controls hold: a string for every field but `bool()` (a boolean) and `files()` (the
 * attached file ids).
 */
export type FormDraft = Readonly<Record<string, string | boolean | readonly string[]>>;

/** Why a control's value is refused: missing, or not one the field accepts. */
export type FieldError = 'required' | 'invalid';

/** A `datetime-local` value, minutes precision, read and written as UTC. */
const LOCAL_MINUTES = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;

function blocksToLines(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((block: unknown) => {
      const text: unknown =
        typeof block === 'object' && block !== null ? Reflect.get(block, 'text') : '';
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

function moneyAmount(value: unknown): string {
  const amount: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'amount') : undefined;
  return typeof amount === 'string' ? amount : '';
}

function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The control's starting value for one field: the record's, else the field's default. */
function draftValue(field: AnyField, value: unknown): string | boolean | readonly string[] {
  const current = value ?? field.options['default'];
  switch (field.type) {
    case 'bool':
      return current === true;
    case 'files':
      return stringsOf(current);
    case 'tags':
      return stringsOf(current).join(', ');
    case 'richText':
      return blocksToLines(current);
    case 'money':
      return moneyAmount(current);
    case 'number':
      return typeof current === 'number' ? String(current) : '';
    case 'dateTime':
      return typeof current === 'string' ? toLocalMinutes(current) : '';
    default:
      return typeof current === 'string' ? current : '';
  }
}

function toLocalMinutes(iso: string): string {
  const instant = new Date(iso);
  return Number.isNaN(instant.getTime()) ? iso : instant.toISOString().slice(0, 16);
}

/** The draft a form starts from: the record's values when editing, the defaults when creating. */
export function draftOf(resource: DefinedResource, record?: RecordValues): FormDraft {
  return Object.fromEntries(
    Object.entries(resource.fields).map(([name, field]) => [
      name,
      draftValue(field, record === undefined ? undefined : fieldValue(record, name)),
    ]),
  );
}

/** Whether a control holds nothing. `bool()` and `files()` always hold a value. */
function isEmpty(value: string | boolean | readonly string[]): boolean {
  return typeof value === 'string' && value.trim().length === 0;
}

/** The value a field's control means, as the field's schema reads it. */
function inputValue(field: AnyField, raw: string | boolean | readonly string[]): unknown {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  switch (field.type) {
    case 'number':
      return Number.isFinite(Number(text)) ? Number(text) : text;
    case 'money':
      return { amount: text, currency: field.options['currency'] };
    case 'tags':
      return text
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
    case 'richText':
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => ({ type: 'paragraph', text: line }));
    case 'dateTime':
      return LOCAL_MINUTES.test(text) ? `${text}:00Z` : text;
    case 'text':
      return raw;
    default:
      return text;
  }
}

/** The outcome of checking a draft: the body the schema accepted, or the errors of each field. */
export type DraftCheck<B> =
  | { readonly ok: true; readonly body: B }
  | { readonly ok: false; readonly errors: Readonly<Record<string, FieldError>> };

/**
 * Turns a draft into the create or update body and checks it with the resource's own create or
 * update schema, the one the route checks with. An empty control is left out of a create when the
 * field is optional or defaulted (the server fills the default), is `null` in an update of an
 * optional field (clearing it), and is `required` otherwise.
 */
export function checkDraft<F extends FieldMap>(
  resource: DefinedResource<F>,
  mode: 'create',
  draft: FormDraft,
): DraftCheck<CreateInput<F>>;
export function checkDraft<F extends FieldMap>(
  resource: DefinedResource<F>,
  mode: 'update',
  draft: FormDraft,
): DraftCheck<UpdateInput<F>>;
export function checkDraft<F extends FieldMap>(
  resource: DefinedResource<F>,
  mode: FormMode,
  draft: FormDraft,
): DraftCheck<CreateInput<F> | UpdateInput<F>> {
  const body: Record<string, unknown> = {};
  const errors: Record<string, FieldError> = {};
  for (const [name, field] of Object.entries(resource.fields)) {
    const raw = draft[name] ?? draftValue(field, undefined);
    if (!isEmpty(raw)) {
      body[name] = inputValue(field, raw);
    } else if (field.optional) {
      if (mode === 'update') body[name] = null;
    } else if (mode === 'update' || !field.defaulted) {
      errors[name] = 'required';
    }
  }
  const schema: z.ZodType<CreateInput<F> | UpdateInput<F>> =
    mode === 'create' ? createInputSchema(resource) : updateInputSchema(resource);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = issue.path[0];
      if (typeof name === 'string' && Object.hasOwn(resource.fields, name))
        errors[name] ??= 'invalid';
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, body: parsed.data };
}

/** The form's state: the draft, each field's error, and the save in flight or failed. */
export interface FormState {
  readonly draft: FormDraft;
  readonly errors: Readonly<Record<string, FieldError>>;
  readonly status: 'editing' | 'saving' | 'failed';
  /** The failed save's problem code, when the failure is the form's rather than a field's. */
  readonly problem: string | null;
}

/** What changes the form's state. */
export type FormAction =
  | {
      readonly type: 'change';
      readonly name: string;
      readonly value: string | boolean | readonly string[];
    }
  | { readonly type: 'refused'; readonly errors: Readonly<Record<string, FieldError>> }
  | { readonly type: 'saving' }
  | { readonly type: 'failed'; readonly code: string; readonly placement: ProblemPlacement }
  | { readonly type: 'saved' };

/** The state a form starts in. */
export function initialForm(draft: FormDraft): FormState {
  return { draft, errors: {}, status: 'editing', problem: null };
}

/**
 * The form's state machine. A change clears its field's error; a refused check marks fields; a
 * server problem marks the fields its details name and, when it names none, fails the form with
 * its code so the alert can say what happened and offer to try again.
 */
export function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'change': {
      const errors = Object.fromEntries(
        Object.entries(state.errors).filter(([name]) => name !== action.name),
      );
      return { ...state, draft: { ...state.draft, [action.name]: action.value }, errors };
    }
    case 'refused':
      return { ...state, errors: action.errors, status: 'failed', problem: null };
    case 'saving':
      return { ...state, status: 'saving', problem: null };
    case 'failed': {
      const errors = Object.fromEntries(
        Object.keys(action.placement.fields).map((name) => [name, 'invalid' as const]),
      );
      const onFields = Object.keys(errors).length > 0;
      return { ...state, errors, status: 'failed', problem: onFields ? null : action.code };
    }
    case 'saved':
      return { ...state, errors: {}, status: 'editing', problem: null };
  }
}
