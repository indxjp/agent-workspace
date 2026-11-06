import { DefinitionError } from '@indx-workspace/sdk/define';
import { describe, expect, it } from 'vitest';

import {
  defineApp,
  defineRecipe,
  defineResource,
  isDefinedApp,
  ref,
  resourceEvent,
  schedule,
  text,
  type AppInput,
  type DefinedResource,
  type RecipeOn,
} from './index.js';

const access = {
  read: 'member',
  create: 'member',
  update: 'member',
  delete: 'role:admin',
} as const;

function resource(
  name: string,
  fields: Parameters<typeof defineResource>[0]['fields'] = { title: text() },
) {
  return defineResource({ name, fields, access });
}

function recipe(name: string, on: RecipeOn) {
  return defineRecipe({ name, on, run: () => Promise.resolve() });
}

/** Calls `defineApp` with a value the types would refuse, returning what it threw. */
function refusal(input: unknown): DefinitionError {
  try {
    defineApp(input as AppInput);
  } catch (error) {
    if (error instanceof DefinitionError) return error;
    throw error;
  }
  throw new Error('defineApp accepted the input');
}

describe('defineApp', () => {
  it('accepts resources that reference each other by name', () => {
    const contact = resource('contact', { name: text(), company: ref('company') });
    const company = resource('company', {
      name: text(),
      main_contact: ref('contact', { optional: true }),
    });
    const app = defineApp({
      name: 'crm',
      resources: [contact, company],
      pages: { home: 'dashboard', nav: ['contacts', 'companies'] },
      agents: ['closer'],
    });
    expect(isDefinedApp(app)).toBe(true);
    expect(app.resources.map((item: DefinedResource) => item.name)).toEqual(['contact', 'company']);
    expect(app.recipes).toEqual([]);
    expect(app.pages).toEqual({ home: 'dashboard', nav: ['contacts', 'companies'] });
    expect(Object.isFrozen(app)).toBe(true);
    expect(JSON.stringify(app)).not.toContain('agentworkspace');
  });

  it('refuses two resources with one name', () => {
    const error = refusal({ name: 'desk', resources: [resource('ticket'), resource('ticket')] });
    expect(error.code).toBe('invalid_definition');
    expect(error.issues).toContainEqual({
      path: 'resources.1',
      message: 'the resource name "ticket" appears more than once',
    });
  });

  it('refuses a ref naming a resource the app does not define', () => {
    const error = refusal({
      name: 'desk',
      resources: [resource('ticket', { title: text(), customer: ref('customer') })],
    });
    expect(error.issues).toEqual([
      {
        path: 'resources.0.fields.customer',
        message: 'ref("customer") names no resource of this app',
      },
    ]);
  });

  it('accepts recipes made by defineRecipe, keeping their order', () => {
    const triage = recipe('triage', resourceEvent('ticket', 'created'));
    const digest = recipe('digest', schedule('0 9 * * 1', 'Asia/Tokyo'));
    const app = defineApp({
      name: 'desk',
      resources: [resource('ticket')],
      recipes: [triage, digest],
    });
    expect(app.recipes.map((item) => item.name)).toEqual(['triage', 'digest']);
    expect(Object.isFrozen(app.recipes)).toBe(true);
  });

  it('refuses an unbranded recipe, two recipes with one name and an event on an unknown resource', () => {
    expect(
      refusal({ name: 'desk', resources: [resource('ticket')], recipes: [{ name: 'triage' }] })
        .issues,
    ).toEqual([{ path: 'recipes.0', message: 'must be made by defineRecipe()' }]);
    const error = refusal({
      name: 'desk',
      resources: [resource('ticket')],
      recipes: [
        recipe('triage', resourceEvent('ticket', 'created')),
        recipe('triage', schedule('0 * * * *')),
        recipe('escalate', resourceEvent('incident', 'updated')),
      ],
    });
    expect(error.issues).toEqual([
      { path: 'recipes.1.name', message: 'the recipe name "triage" appears more than once' },
      {
        path: 'recipes.2.on.resource',
        message: 'resourceEvent("incident") names no resource of this app',
      },
    ]);
  });

  // `aw generate app` and `--template portal` write `resources: []`; `aw dev` loads it (#1476).
  it('accepts an app of pages only, with no resources', () => {
    const app = defineApp({ name: 'portal', resources: [] });
    expect(app.resources).toEqual([]);
    expect(isDefinedApp(app)).toBe(true);
  });

  it('accepts an empty recipe list', () => {
    expect(
      defineApp({ name: 'desk', resources: [resource('ticket')], recipes: [] }).recipes,
    ).toEqual([]);
  });

  it.each([
    ['a name that is not a kebab key', { name: 'Service Desk' }, 'name'],
    ['a name too long for app_<name>', { name: 'a'.repeat(60) }, 'name'],
    ['a resource not made by defineResource', { resources: [{ name: 'ticket' }] }, 'resources.0'],
  ])('refuses %s', (_, change, path) => {
    const error = refusal({ name: 'desk', resources: [resource('ticket')], ...change });
    expect(error.issues.map((issue) => issue.path)).toContain(path);
  });

  it('names the key an unknown root key is closest to', () => {
    const error = refusal({ name: 'desk', resources: [resource('ticket')], page: {} });
    expect(error.issues[0]?.message).toContain('did you mean "pages"?');
  });
});
