/**
 * The agent tools of an app (F-10, issue #1504), derived from its resources: for a resource whose
 * `agents.read` is `true`, `<name>_list`, `<name>_get` and, when it declares `search`,
 * `<name>_search`; for one whose `agents.write` lists fields, `<name>_update`, whose input names
 * only those fields. A `definePages` resource (issue #1520) also has `<name>_children` to read the
 * tree and `<name>_create(parent, title, markdown)`, the one create tool there is; its
 * `<name>_update` takes the body as `markdown` and an optional `expectedRevisionId`. There are no
 * delete tools.
 *
 * Each tool has a strict Zod input (an unknown key is refused) and advertises the JSON Schema its
 * fields' `toolSchema` describe. A call runs through the store port as the person the identity
 * assertion names, so the store applies the resource's `access` ∩ `agents.write` and records the
 * run on the audit row and on a page's revision; this module checks neither itself. `richText()`
 * values go in and come out as markdown (`pages/blocks.ts`). No I/O of its own: the store is given.
 */
import { z } from 'zod';

import type { DefinedApp } from '../app.js';
import { AppStoreError } from '../db/errors.js';
import { isPageStore } from '../db/page-policy.js';
import type { PageStore } from '../db/page-port.js';
import type { ResourceStore } from '../db/port.js';
import type { RichTextBlock } from '../fields/rich-text.js';
import type { AnyField, JsonSchema } from '../fields/types.js';
import { blocksToMarkdown, markdownToBlocks } from '../pages/blocks.js';
import { isPageResource, PAGE_TITLE_MAX, type DefinedPages } from '../pages/define-pages.js';
import type { Person } from '../person.js';
import type { DefinedResource, FieldMap } from '../resource.js';

/** The kinds of agent tool; `children` and `create` are a page resource's only. */
type AgentToolKind = 'list' | 'get' | 'search' | 'update' | 'children' | 'create';

/** A tool's input as MCP advertises it: a JSON Schema object that admits no other key. */
interface AgentToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

/** One agent tool of an app. */
export interface AgentTool {
  /** `<resource name>_<kind>`, such as `ticket_update`. */
  readonly name: string;
  readonly kind: AgentToolKind;
  readonly resource: DefinedResource;
  readonly description: string;
  readonly inputSchema: AgentToolInputSchema;
  /** The strict schema a call's `arguments` are parsed with. */
  readonly input: z.ZodType<Readonly<Record<string, unknown>>>;
}

const LIMIT_MAX = 200;
const CURSOR_MAX = 2048;
const QUERY_MAX = 500;
/** The longest markdown a `richText()` value is accepted as: the field's own 256 KiB bound. */
const MARKDOWN_MAX = 256 * 1024;
/** The list tool's own keys; an `enumOf()` field of the same name is not offered as a filter. */
const PAGE_KEYS = new Set(['cursor', 'limit']);

const PAGE_SHAPE = {
  cursor: z.string().min(1).max(CURSOR_MAX).optional(),
  limit: z.number().int().min(1).max(LIMIT_MAX).optional(),
};

const PAGE_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  cursor: { type: 'string', description: 'The nextCursor of the page before.' },
  limit: { type: 'integer', minimum: 1, maximum: LIMIT_MAX, description: 'Default 50.' },
};

const ID_PROPERTY: JsonSchema = { type: 'string', format: 'uuid', description: 'The record id.' };

/**
 * The schema a field is advertised with. A `person()` field takes a principal id only.
 *
 * shortcut: no email-to-principal resolution for `person()` input; upgrade when an agent journey
 * needs to name a person by address.
 */
function toolSchemaOf(field: AnyField): JsonSchema {
  const schema: JsonSchema =
    field.type === 'person'
      ? { type: 'string', format: 'uuid', description: 'The principal id of a workspace member.' }
      : field.toolSchema;
  return field.optional ? { anyOf: [schema, { type: 'null' }] } : schema;
}

/** The value schema of a field in a tool's input: markdown for `richText()`. */
function inputZodOf(field: AnyField): z.ZodType {
  const value = field.type === 'richText' ? z.string().max(MARKDOWN_MAX) : field.zod;
  return field.optional ? value.nullable().optional() : value.optional();
}

function enumFieldsOf(resource: DefinedResource): [string, AnyField][] {
  return Object.entries(resource.fields).filter(
    ([key, field]) => field.type === 'enumOf' && !PAGE_KEYS.has(key),
  );
}

function listTool(resource: DefinedResource): AgentTool {
  const filters = enumFieldsOf(resource);
  return {
    name: `${resource.name}_list`,
    kind: 'list',
    resource,
    description:
      `List the ${resource.plural} records you may read, newest first, a page at a time.` +
      (filters.length === 0 ? '' : ' Filter by any of the enum fields.'),
    inputSchema: {
      type: 'object',
      properties: {
        ...PAGE_PROPERTIES,
        ...Object.fromEntries(filters.map(([key, field]) => [key, field.toolSchema])),
      },
      additionalProperties: false,
    },
    input: z.strictObject({
      ...PAGE_SHAPE,
      ...Object.fromEntries(filters.map(([key, field]) => [key, field.zod.optional()])),
    }),
  };
}

function getTool(resource: DefinedResource): AgentTool {
  return {
    name: `${resource.name}_get`,
    kind: 'get',
    resource,
    description: `Read one ${resource.name} record by its id.`,
    inputSchema: {
      type: 'object',
      properties: { id: ID_PROPERTY },
      required: ['id'],
      additionalProperties: false,
    },
    input: z.strictObject({ id: z.uuid() }),
  };
}

function searchTool(resource: DefinedResource): AgentTool {
  return {
    name: `${resource.name}_search`,
    kind: 'search',
    resource,
    description: `Search the ${resource.plural} records you may read by the words of ${resource.search.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', minLength: 1, maxLength: QUERY_MAX, description: 'The words.' },
        ...PAGE_PROPERTIES,
      },
      required: ['q'],
      additionalProperties: false,
    },
    input: z.strictObject({ q: z.string().min(1).max(QUERY_MAX), ...PAGE_SHAPE }),
  };
}

function updateTool(resource: DefinedResource, writable: readonly string[]): AgentTool {
  const fields = writable.flatMap((key): [string, AnyField][] => {
    const field = resource.fields[key];
    return field === undefined ? [] : [[key, field]];
  });
  return {
    name: `${resource.name}_update`,
    kind: 'update',
    resource,
    description: `Change the fields ${writable.join(', ')} of one ${resource.name} record you may change.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: ID_PROPERTY,
        ...Object.fromEntries(fields.map(([key, field]) => [key, toolSchemaOf(field)])),
      },
      required: ['id'],
      additionalProperties: false,
    },
    input: z.strictObject({
      id: z.uuid(),
      ...Object.fromEntries(fields.map(([key, field]) => [key, inputZodOf(field)])),
    }),
  };
}

/** The tool input key a page field is written through: the body is `markdown`. */
const PAGE_INPUT_KEYS: Readonly<Record<string, string>> = { blocks: 'markdown' };

const MARKDOWN_PROPERTY: JsonSchema = {
  type: 'string',
  contentMediaType: 'text/markdown',
  description: 'The page body as markdown: headings, lists, quotes, code and paragraphs.',
};

const PARENT_PROPERTY: JsonSchema = {
  anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
  description: 'The id of the page it is under; null or left out for the top.',
};

/** The page fields of `names` the agent writes, each with its input key, schema and value. */
function pageInputs(
  resource: DefinedPages<FieldMap>,
  names: readonly string[],
): [string, JsonSchema, z.ZodType][] {
  return names.flatMap((name): [string, JsonSchema, z.ZodType][] => {
    const field = resource.fields[name];
    if (field === undefined) return [];
    if (name === 'blocks') {
      return [[PAGE_INPUT_KEYS[name] ?? name, MARKDOWN_PROPERTY, z.string().max(MARKDOWN_MAX)]];
    }
    return [[name, toolSchemaOf(field), field.zod]];
  });
}

function childrenTool(resource: DefinedPages<FieldMap>): AgentTool {
  return {
    name: `${resource.name}_children`,
    kind: 'children',
    resource,
    description: `List the ${resource.plural} directly under one ${resource.name} (or at the top), in order.`,
    inputSchema: {
      type: 'object',
      properties: { parent: PARENT_PROPERTY },
      additionalProperties: false,
    },
    input: z.strictObject({ parent: z.uuid().nullable().optional() }),
  };
}

function pageUpdateTool(resource: DefinedPages<FieldMap>, writable: readonly string[]): AgentTool {
  const inputs = pageInputs(
    resource,
    writable.filter((name) => name === 'title' || name === 'blocks'),
  );
  return {
    name: `${resource.name}_update`,
    kind: 'update',
    resource,
    description:
      `Change the ${inputs.map(([key]) => key).join(' and ')} of one ${resource.name} you may change; ` +
      'pass the revision_id you read as expectedRevisionId to refuse overwriting a newer edit.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID_PROPERTY,
        ...Object.fromEntries(inputs.map(([key, schema]) => [key, schema])),
        expectedRevisionId: {
          type: 'string',
          format: 'uuid',
          description: 'The revision_id of the page as you read it.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    input: z.strictObject({
      id: z.uuid(),
      ...Object.fromEntries(inputs.map(([key, , value]) => [key, value.optional()])),
      expectedRevisionId: z.uuid().optional(),
    }),
  };
}

function pageCreateTool(resource: DefinedPages<FieldMap>): AgentTool {
  const space = resource.space ? pageInputs(resource, ['space']) : [];
  return {
    name: `${resource.name}_create`,
    kind: 'create',
    resource,
    description: `Create one ${resource.name} with a title and a markdown body, under a parent ${resource.name} or at the top.`,
    inputSchema: {
      type: 'object',
      properties: {
        parent: PARENT_PROPERTY,
        title: { type: 'string', maxLength: PAGE_TITLE_MAX },
        markdown: MARKDOWN_PROPERTY,
        ...Object.fromEntries(space.map(([key, schema]) => [key, schema])),
      },
      required: ['title', ...space.map(([key]) => key)],
      additionalProperties: false,
    },
    input: z.strictObject({
      parent: z.uuid().nullable().optional(),
      title: z.string().max(PAGE_TITLE_MAX),
      markdown: z.string().max(MARKDOWN_MAX).optional(),
      ...Object.fromEntries(space.map(([key, , value]) => [key, value])),
    }),
  };
}

/** The tools of a page resource: list, get, search, children, update, create. */
function toolsOfPages(resource: DefinedPages<FieldMap>): AgentTool[] {
  const { read, write } = resource.agents;
  return [
    ...(read ? [listTool(resource), getTool(resource), searchTool(resource)] : []),
    ...(read ? [childrenTool(resource)] : []),
    ...(write === false ? [] : [pageUpdateTool(resource, write), pageCreateTool(resource)]),
  ];
}

/** The tools of one resource, in the order list, get, search, update. */
function toolsOfResource(resource: DefinedResource): AgentTool[] {
  if (isPageResource(resource)) return toolsOfPages(resource);
  const { read, write } = resource.agents;
  return [
    ...(read ? [listTool(resource), getTool(resource)] : []),
    ...(read && resource.search.length > 0 ? [searchTool(resource)] : []),
    ...(write === false ? [] : [updateTool(resource, write)]),
  ];
}

/** Every agent tool of `app`, resource by resource. */
export function agentToolsOf(app: DefinedApp): readonly AgentTool[] {
  return Object.freeze(app.resources.flatMap(toolsOfResource));
}

function issuePaths(issue: z.core.$ZodIssue): string[] {
  const base = issue.path.map(String).join('.');
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => (base === '' ? key : `${base}.${key}`));
  }
  return [base === '' ? '$' : base];
}

function unrecognizedKeys(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' && issue.path.length === 0 ? issue.keys : [],
  );
}

/**
 * The parsed arguments of a call to `tool`.
 *
 * @throws {AppStoreError} `forbidden` naming each `fields:<name>` when an update names a field of
 *   the resource that `agents.write` does not list (as the store would); otherwise `invalid_body`
 *   (update) or `invalid_query` (list, get, search) with the offending paths.
 */
export function parseToolArguments(
  tool: AgentTool,
  args: unknown,
): Readonly<Record<string, unknown>> {
  const result = tool.input.safeParse(args ?? {});
  if (result.success) return result.data;
  const writes = tool.kind === 'update' || tool.kind === 'create';
  if (writes) {
    // A page's body is written as `markdown`: refused, it is named as the field it writes.
    const fieldOf = (key: string): string =>
      isPageResource(tool.resource) && key === PAGE_INPUT_KEYS['blocks'] ? 'blocks' : key;
    const outside = unrecognizedKeys(result.error)
      .map(fieldOf)
      .filter((key) => Object.hasOwn(tool.resource.fields, key));
    if (outside.length > 0) {
      throw new AppStoreError('forbidden', { details: outside.map((key) => `fields:${key}`) });
    }
  }
  const details = [...new Set(result.error.issues.flatMap(issuePaths))];
  throw new AppStoreError(writes ? 'invalid_body' : 'invalid_query', { details });
}

/** A record as a tool returns it: every `richText()` value as markdown. */
function recordForAgent(
  resource: DefinedResource,
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      resource.fields[key]?.type === 'richText' && Array.isArray(value)
        ? blocksToMarkdown(value as RichTextBlock[])
        : value,
    ]),
  );
}

function patchOf(
  resource: DefinedResource,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args)
      .filter(([key]) => key !== 'id')
      .map(([key, value]) => [
        key,
        resource.fields[key]?.type === 'richText' && typeof value === 'string'
          ? markdownToBlocks(value)
          : value,
      ]),
  );
}

/** The page store a page tool runs on; any other store is a misconfigured runtime. */
function pageStoreOf(store: ResourceStore): PageStore {
  if (!isPageStore(store)) throw new AppStoreError('internal_error');
  return store;
}

/** A page tool's write as the page store takes it: `markdown` as blocks, the rest as given. */
function pageWriteOf(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args)
      .filter(([key, value]) => key !== 'id' && value !== undefined)
      .map(([key, value]) =>
        key === PAGE_INPUT_KEYS['blocks']
          ? ['blocks', markdownToBlocks(String(value))]
          : [key, value],
      ),
  );
}

/** Runs a page resource's own tools: children, and the create and update that write revisions. */
async function callPageTool(
  tool: AgentTool,
  parsed: Readonly<Record<string, unknown>>,
  person: Person,
  store: PageStore,
): Promise<Record<string, unknown> | undefined> {
  const forAgent = (record: Readonly<Record<string, unknown>>): Record<string, unknown> =>
    recordForAgent(tool.resource, record);
  switch (tool.kind) {
    case 'children': {
      const parent = typeof parsed['parent'] === 'string' ? parsed['parent'] : null;
      return { items: (await store.children(person, parent)).map(forAgent) };
    }
    case 'create': {
      const { parent, ...rest } = pageWriteOf({ markdown: '', ...parsed });
      const input = typeof parent === 'string' ? { ...rest, parent } : rest;
      return forAgent(await store.create(person, input));
    }
    case 'update':
      return forAgent(await store.update(person, String(parsed['id']), pageWriteOf(parsed)));
    default:
      return undefined;
  }
}

function pageOptions(args: Readonly<Record<string, unknown>>): {
  cursor?: string;
  limit?: number;
} {
  return {
    ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
    ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
  };
}

/**
 * Runs `tool` with `args` as `person` on `store`: list and search answer `{ items, nextCursor }`,
 * get and update the record.
 *
 * @throws {AppStoreError} for arguments {@link parseToolArguments} refuses, and whatever the store
 *   refuses or fails with.
 */
export async function callAgentTool(
  tool: AgentTool,
  args: unknown,
  person: Person,
  store: ResourceStore,
): Promise<Record<string, unknown>> {
  const parsed = parseToolArguments(tool, args);
  const { resource } = tool;
  if (isPageResource(resource)) {
    const answer = await callPageTool(tool, parsed, person, pageStoreOf(store));
    if (answer !== undefined) return answer;
  }
  const forAgent = (record: Readonly<Record<string, unknown>>): Record<string, unknown> =>
    recordForAgent(resource, record);
  switch (tool.kind) {
    case 'children':
    case 'create':
      // Derived for page resources only, which `callPageTool` answered.
      throw new AppStoreError('internal_error');
    case 'list': {
      const where = Object.fromEntries(
        enumFieldsOf(resource).flatMap(([key]) =>
          typeof parsed[key] === 'string' ? [[key, parsed[key]]] : [],
        ),
      );
      const page = await store.list(person, {
        ...pageOptions(parsed),
        ...(Object.keys(where).length === 0 ? {} : { where }),
      });
      return { items: page.items.map(forAgent), nextCursor: page.nextCursor };
    }
    case 'search': {
      const page = await store.search(person, String(parsed['q']), pageOptions(parsed));
      return { items: page.items.map(forAgent), nextCursor: page.nextCursor };
    }
    case 'get':
      return forAgent(await store.get(person, String(parsed['id'])));
    case 'update':
      return forAgent(await store.update(person, String(parsed['id']), patchOf(resource, parsed)));
  }
}
