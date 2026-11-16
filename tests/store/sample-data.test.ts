/**
 * What every live Agent Store entry shows a visitor: the prompts it suggests, the moment those
 * prompts must show (`demo.check`) and, for the entries whose data is not a seed folder, the
 * sample records the demo runs on (`demo.records`).
 *
 * The catalog cannot read the repository around it (the No fork cell), so the checks that need the
 * agent definitions, the app resources and the sample files are here: every tool a check names is
 * one the demo agent can call, every record parses against the resource or fixture it stands for,
 * no sample file names a real address or phone number, and the numbers the card shows are the
 * records' counts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { PAGE_BLOCK_TYPES } from '@indx-workspace/app';
import { describe, expect, it } from 'vitest';

import type { LiveEntry } from '../../examples/store/catalog/define.ts';
import { CATALOG } from '../../examples/store/catalog/index.ts';
import { DEMO_SAMPLE_FILE_MAX_BYTES } from '../../apps/web/server/demo/provision/limits.ts';
import { REPOSITORY_ROOT } from '../apps/registry.ts';
import { demoAgentDefinition } from './demo-agents.test-support.ts';

const live = CATALOG.filter((entry): entry is LiveEntry => entry.status === 'live');
const LANGS = ['ja', 'en'] as const;
type Lang = (typeof LANGS)[number];

const sourceOf = (entry: LiveEntry): string => path.join(REPOSITORY_ROOT, entry.source);
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;

// ---------------------------------------------------------------------------------------------
// The tools a demo agent can call
// ---------------------------------------------------------------------------------------------

interface DefinedAgent {
  readonly permissions?: {
    readonly readFiles?: boolean;
    readonly writeFiles?: boolean;
    readonly runCommands?: boolean;
  };
  readonly engine?: { readonly handoff?: boolean };
  readonly files?: readonly unknown[];
  readonly tools?: readonly (
    | { readonly connector: string }
    | { readonly name: string; readonly spec: string; readonly allow?: readonly string[] }
  )[];
}

/**
 * One resource of an example app, read from its source file (the apps are not importable here).
 *
 * The tool-naming rule in `appToolNames` below and the field constructors read by `FIELD_LINE` are
 * a second copy of `packages/app/src/server/mcp-tools.ts` (`agentToolsOf`) and the field schemas,
 * because `@indx-workspace/app` does not resolve from the root tests project. That file is the
 * source of truth: change the rule there and mirror it here (a mismatch fails as "not a field" or
 * as a tool the demo agent cannot call).
 */
interface AppResource {
  readonly name: string;
  readonly page: boolean;
  readonly fields: ReadonlyMap<
    string,
    { readonly ctor: string; readonly optional: boolean; readonly args: string }
  >;
  readonly read: boolean;
  readonly write: readonly string[] | false;
  readonly search: boolean;
}

const FIELD_LINE =
  /^\s+(\w+): (text|ref|person|enumOf|money|richText|tags|bool|number|files)\((.*)\),?$/gmu;

/** The resource a `resources/<name>.ts` file defines, read as text. */
function readResource(file: string): AppResource {
  const text = readFileSync(file, 'utf8');
  const page = text.includes('definePages(');
  const fields = new Map<string, { ctor: string; optional: boolean; args: string }>();
  if (page) {
    fields.set('title', { ctor: 'text', optional: false, args: '' });
    fields.set('parent', { ctor: 'ref', optional: true, args: "'page'" });
    fields.set('position', { ctor: 'number', optional: true, args: '' });
    fields.set('blocks', { ctor: 'richText', optional: false, args: '' });
    if (/space: true/u.test(text))
      fields.set('space', { ctor: 'ref', optional: false, args: "'space'" });
  }
  for (const match of text.matchAll(FIELD_LINE)) {
    const args = match[3] ?? '';
    fields.set(match[1] ?? '', {
      ctor: match[2] ?? '',
      optional: /optional: true/u.test(args),
      args,
    });
  }
  const agents = /agents: \{ read: (true|false)(?:, write: (\[[^\]]*\]|false))? \}/u.exec(text);
  const write =
    agents?.[2] === undefined || agents[2] === 'false'
      ? false
      : [...agents[2].matchAll(/'(\w+)'/gu)].map((match) => match[1] ?? '');
  return {
    name: page ? 'page' : (/name: '(\w+)'/u.exec(text)?.[1] ?? ''),
    page,
    fields,
    read: agents?.[1] === 'true',
    write,
    search: page || /search: \[[^\]]+\]/u.test(text),
  };
}

/** The resources an example app lists in its `app.config.ts`. */
function readApp(source: string): AppResource[] {
  const config = readFileSync(path.join(source, 'app.config.ts'), 'utf8');
  return [...config.matchAll(/from '\.\/resources\/(\w+)\.ts'/gu)].map((match) =>
    readResource(path.join(source, 'resources', `${match[1] ?? ''}.ts`)),
  );
}

/** What an app's agent tools are named, by the rule the app's MCP endpoint applies. */
function appToolNames(resource: AppResource): string[] {
  const { name, read, write } = resource;
  return [
    ...(read ? [`${name}_list`, `${name}_get`] : []),
    ...(read && resource.search ? [`${name}_search`] : []),
    ...(resource.page && read ? [`${name}_children`] : []),
    ...(write === false ? [] : [`${name}_update`]),
    ...(resource.page && write !== false ? [`${name}_create`] : []),
  ];
}

/** The operation ids a tool's `allow` admits from its OpenAPI document. */
function admittedOperations(specFile: string, allow: readonly string[] = []): string[] {
  const document = readJson(specFile) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  const admitted: string[] = [];
  for (const [route, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (operation.operationId === undefined) continue;
      const matches = allow.some((rule) => {
        if (rule === `operationId:${operation.operationId}`) return true;
        const [verb, pattern] = rule.split(' ');
        if (pattern === undefined || verb?.toLowerCase() !== method) return false;
        // A glob `*` is exactly one path segment.
        const expression = pattern
          .split('*')
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
          .join('[^/]+');
        return new RegExp(`^${expression}$`, 'u').test(route);
      });
      if (matches) admitted.push(operation.operationId);
    }
  }
  return admitted;
}

/** The tools of the MCP server `connector` that the source folder ships (`mcp/*.mjs`). */
function serverTools(source: string, connector: string): string[] {
  const folder = path.join(source, 'mcp');
  if (!existsSync(folder)) return [];
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.mjs'))) {
    const text = readFileSync(path.join(folder, file), 'utf8');
    const server = new RegExp(`serveTools\\(\\{\\s*name: '${connector}',`, 'u').exec(text);
    if (server === null) continue;
    return [...text.slice(server.index).matchAll(/^ {6}name: '([a-z_]+)',/gmu)].map(
      (match) => match[1] ?? '',
    );
  }
  return [];
}

/** Every tool the demo agent of `entry` can call, by the plain name a run reports. */
function callableTools(entry: LiveEntry): Set<string> {
  const defined = demoAgentDefinition(entry) as DefinedAgent;
  const tools = new Set<string>();
  const { permissions = {}, engine = {} } = defined;
  if (permissions.readFiles === true) tools.add('Read');
  if (permissions.readFiles === true && (defined.files?.length ?? 0) > 0) tools.add('search_files');
  if (permissions.writeFiles === true) tools.add('Write');
  if (permissions.runCommands === true) tools.add('run_skill_script');
  if (engine.handoff === true) tools.add('handoff_to_person');
  for (const tool of defined.tools ?? []) {
    if ('connector' in tool) {
      const names =
        entry.kind === 'app'
          ? readApp(sourceOf(entry)).flatMap(appToolNames)
          : serverTools(sourceOf(entry), tool.connector);
      for (const name of names) tools.add(name);
    } else {
      const spec = path.join(sourceOf(entry), tool.spec);
      for (const name of admittedOperations(spec, tool.allow)) tools.add(name);
    }
  }
  return tools;
}

describe('the moment each live entry shows', () => {
  it('is stated for every live entry, as the tools one suggested prompt must call', () => {
    const missing = live.filter((entry) => entry.demo.check === undefined).map((e) => e.slug);
    expect(missing).toEqual([]);
  });

  it.each(live.map((entry) => [entry.slug, entry] as const))(
    '%s: names only tools its demo agent can call, and the approval tool apart from the others',
    (_slug, entry) => {
      const check = entry.demo.check;
      if (check === undefined) throw new Error(`${entry.slug} has no demo.check`);
      const callable = callableTools(entry);
      const named = check.approval === null ? check.tools : [...check.tools, check.approval];
      expect(named.filter((name) => !callable.has(name))).toEqual([]);
      if (check.approval !== null) expect(check.tools).not.toContain(check.approval);
      expect(new Set(check.tools).size).toBe(check.tools.length);
    },
  );

  it('knows the tools an app agent gets and the ones a gallery agent gets', () => {
    // A guard on the helper itself: if it stopped finding tools, every check above would fail
    // for the wrong reason, or worse pass on an empty set.
    const bySlug = (slug: string): Set<string> => {
      const entry = live.find((candidate) => candidate.slug === slug);
      if (entry === undefined) throw new Error(`no entry ${slug}`);
      return callableTools(entry);
    };
    expect(bySlug('crm-sales')).toContain('contact_update');
    expect(bySlug('crm-sales')).not.toContain('deal_create');
    expect(bySlug('wiki')).toContain('page_create');
    expect(bySlug('service-desk')).toContain('kb_article_search');
    expect(bySlug('service-desk')).not.toContain('kb_article_update');
    expect(bySlug('quotation')).toEqual(
      new Set(['Read', 'run_skill_script', 'searchParts', 'getOrder', 'getRate', 'createQuote']),
    );
    expect(bySlug('ringi-review')).toContain('check_authority');
    expect(bySlug('meeting-minutes')).toContain('list_members');
  });

  it('is exercised by suggested prompts in both languages, each naming only files the demo has', () => {
    const problems: string[] = [];
    for (const entry of live) {
      expect(entry.demo.prompts.length).toBeGreaterThanOrEqual(2);
      for (const [at, prompt] of entry.demo.prompts.entries()) {
        for (const lang of LANGS) {
          // A prompt that points at a seeded file names it by `<collection>/<file>`.
          for (const match of prompt[lang].matchAll(
            /(?:^|[\s（(])((?:contracts|transcripts)\/[^\s、。）)]+)/gu,
          )) {
            const named = (match[1] ?? '').replace(/\.+$/u, '');
            const [collection, ...rest] = named.split('/');
            const seed = entry.demo.seed.find((folder) => folder.collection === collection);
            const file = seed === undefined ? null : path.join(sourceOf(entry), seed.from, ...rest);
            if (file === null || !existsSync(file)) {
              problems.push(`${entry.slug}: prompt ${String(at)} (${lang}) names ${named}`);
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Sample records
// ---------------------------------------------------------------------------------------------

const withRecords = live.filter((entry) => entry.demo.records !== undefined);
const recordsFolder = (entry: LiveEntry, lang: Lang): string =>
  path.join(sourceOf(entry), entry.demo.records ?? '', lang);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Whether `value` is one the field's type holds (the app's own field types, in JSON form). */
function validValue(field: { ctor: string; args: string }, value: unknown): boolean {
  switch (field.ctor) {
    case 'text':
      return typeof value === 'string' && value.trim() !== '';
    case 'ref':
    case 'person':
      return typeof value === 'string' && UUID.test(value);
    case 'enumOf':
      return [...field.args.matchAll(/'(\w+)'/gu)].some((match) => match[1] === value);
    case 'money': {
      const money = value as { amount?: unknown; currency?: unknown };
      return (
        typeof money.amount === 'string' &&
        /^\d+(?:\.\d+)?$/u.test(money.amount) &&
        typeof money.currency === 'string'
      );
    }
    case 'richText':
      return (
        Array.isArray(value) &&
        value.every(
          (block: { type?: unknown; text?: unknown }) =>
            typeof block.type === 'string' && typeof block.text === 'string',
        )
      );
    case 'tags':
      return Array.isArray(value) && value.every((tag) => typeof tag === 'string' && tag !== '');
    case 'bool':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    default:
      return false;
  }
}

describe('the sample records of an entry with no sample files', () => {
  it('are named by exactly the entries whose seed is empty', () => {
    const unseeded = live.filter((entry) => entry.demo.seed.length === 0).map((e) => e.slug);
    expect(withRecords.map((entry) => entry.slug).sort()).toEqual(unseeded.sort());
    for (const entry of live) {
      // An entry with files to seed keeps them; records are the other way to carry sample data.
      if (entry.demo.seed.length > 0) expect(entry.demo.records).toBeUndefined();
    }
  });

  it.each(withRecords.map((entry) => [entry.slug, entry] as const))(
    '%s: a folder inside its source holds a Japanese and an English set with the same records',
    (_slug, entry) => {
      const folder = path.join(sourceOf(entry), entry.demo.records ?? '');
      expect(statSync(folder).isDirectory()).toBe(true);
      const names = LANGS.map((lang) => readdirSync(recordsFolder(entry, lang)).sort());
      expect(names[0]?.length).toBeGreaterThan(0);
      expect(names[0]).toEqual(names[1]);
      for (const file of names[0] ?? []) {
        const [ja, en] = LANGS.map((lang) => readJson(path.join(recordsFolder(entry, lang), file)));
        const key = (value: unknown): string[] =>
          Array.isArray(value)
            ? value.map((row) => String((row as { id?: string }).id))
            : Object.keys(value as object);
        // The same records in the same order: only the words differ.
        expect(key(ja), file).toEqual(key(en));
      }
    },
  );

  describe.each(
    (['crm-sales', 'team-chat', 'wiki', 'service-desk'] as const).map((slug) => {
      const entry = withRecords.find((candidate) => candidate.slug === slug);
      if (entry === undefined) throw new Error(`no entry ${slug}`);
      return [slug, entry] as const;
    }),
  )('%s', (_slug, entry) => {
    const resources = new Map(
      readApp(sourceOf(entry)).map((resource) => [resource.name, resource]),
    );

    it.each(LANGS)('%s records parse against the app resources and point at each other', (lang) => {
      const folder = recordsFolder(entry, lang);
      const tables = new Map<string, Record<string, unknown>[]>();
      for (const file of readdirSync(folder)) {
        tables.set(
          path.basename(file, '.json'),
          readJson(path.join(folder, file)) as Record<string, unknown>[],
        );
      }
      const ids = new Map(
        [...tables].map(([name, rows]) => [name, new Set(rows.map((row) => String(row['id'])))]),
      );
      expect([...tables.keys()].filter((name) => !resources.has(name))).toEqual([]);
      const problems: string[] = [];
      for (const [name, rows] of tables) {
        const resource = resources.get(name);
        if (resource === undefined) continue;
        for (const row of rows) {
          const { id, ...values } = row;
          const where = `${name} ${String(id)}`;
          if (!UUID.test(String(id))) problems.push(`${where}: the id is not a uuid`);
          for (const key of Object.keys(values)) {
            if (!resource.fields.has(key)) problems.push(`${where}.${key}: not a field`);
          }
          for (const [key, field] of resource.fields) {
            const value = values[key];
            if (value === undefined) {
              if (!field.optional) problems.push(`${where}: ${key} is missing`);
              continue;
            }
            if (!validValue(field, value)) problems.push(`${where}: ${key} is not a valid value`);
            const target = /^'(\w+)'/u.exec(field.args)?.[1];
            if (
              field.ctor === 'ref' &&
              ids.get(target ?? '')?.has(typeof value === 'string' ? value : '') !== true
            ) {
              problems.push(`${where}: ${key} points at no ${String(target)}`);
            }
          }
        }
        expect(new Set(rows.map((row) => row['id'])).size, `${name} ids are distinct`).toBe(
          rows.length,
        );
      }
      expect(problems).toEqual([]);
    });
  });

  describe('of the quotation entry', () => {
    const entry = withRecords.find((candidate) => candidate.slug === 'quotation');
    if (entry === undefined) throw new Error('no entry quotation');
    const fixtures = path.join(sourceOf(entry), 'data', 'erp');
    /** The type of every top-level value of `value`, so two records can be compared by shape. */
    const shape = (value: unknown): unknown =>
      Array.isArray(value)
        ? ['array', ...new Set(value.map((item) => JSON.stringify(shape(item))))].map((x) => x)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]))
          : typeof value;

    it.each(LANGS)('%s parts, orders and rates have the shape of the ERP fixtures', (lang) => {
      for (const name of ['parts', 'orders', 'rates']) {
        const sample = readJson(path.join(recordsFolder(entry, lang), `${name}.json`));
        const fixture = readJson(path.join(fixtures, `${name}.json`));
        if (name === 'rates') {
          const [one] = Object.values(sample as Record<string, unknown>);
          const [other] = Object.values(fixture as Record<string, unknown>);
          expect(shape(one)).toEqual(shape(other));
        } else {
          for (const row of sample as unknown[]) {
            expect(shape(row), name).toEqual(shape((fixture as unknown[])[0]));
          }
        }
      }
    });

    it.each(LANGS)('%s orders and parts agree, and every order names a known part', (lang) => {
      const read = (name: string): unknown => readJson(path.join(recordsFolder(entry, lang), name));
      const parts = read('parts.json') as {
        partNo: string;
        orderNos: string[];
        customer: string;
      }[];
      const orders = read('orders.json') as {
        orderNo: string;
        partNo: string;
        customer: string;
        quantity: number;
        unitPrice: number;
        amount: number;
      }[];
      const partNos = new Set(parts.map((part) => part.partNo));
      for (const order of orders) {
        expect(partNos.has(order.partNo), order.orderNo).toBe(true);
        expect(order.amount, order.orderNo).toBe(order.quantity * order.unitPrice);
        const part = parts.find((candidate) => candidate.partNo === order.partNo);
        expect(part?.orderNos, order.partNo).toContain(order.orderNo);
        expect(part?.customer, order.orderNo).toBe(order.customer);
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The prompts point at records that exist
// ---------------------------------------------------------------------------------------------

describe('the first suggested prompt of an entry with sample records', () => {
  const records = (slug: string, lang: Lang, name: string): Record<string, unknown>[] => {
    const entry = withRecords.find((candidate) => candidate.slug === slug);
    if (entry === undefined) throw new Error(`no entry ${slug}`);
    return readJson(path.join(recordsFolder(entry, lang), `${name}.json`)) as Record<
      string,
      unknown
    >[];
  };
  const prompt = (slug: string, lang: Lang): string => {
    const entry = withRecords.find((candidate) => candidate.slug === slug);
    return entry?.demo.prompts[0]?.[lang] ?? '';
  };

  it.each(LANGS)(
    'crm-sales (%s): the contact it names has no company, and its domain is one',
    (lang) => {
      const contact = records('crm-sales', lang, 'contact').find((row) =>
        prompt('crm-sales', lang).includes(String(row['email'])),
      );
      expect(contact, 'the prompt names a contact by email').toBeDefined();
      expect(contact?.['company']).toBeUndefined();
      const domain = String(contact?.['email']).split('@')[1];
      expect(records('crm-sales', lang, 'company').some((row) => row['domain'] === domain)).toBe(
        true,
      );
    },
  );

  it.each(LANGS)('service-desk (%s): the ticket it names exists and is new', (lang) => {
    const ticket = records('service-desk', lang, 'ticket').find(
      (row) =>
        prompt('service-desk', lang).includes(`「${String(row['title'])}」`) ||
        prompt('service-desk', lang).includes(`"${String(row['title'])}"`),
    );
    expect(ticket, 'the prompt names a ticket by title').toBeDefined();
    expect(ticket?.['status']).toBe('new');
  });

  it.each(LANGS)('team-chat (%s): the channel it names has messages to sum up', (lang) => {
    const channel = records('team-chat', lang, 'channel').find((row) =>
      prompt('team-chat', lang).includes(`#${String(row['name'])}`),
    );
    expect(channel, 'the prompt names a channel').toBeDefined();
    const messages = records('team-chat', lang, 'message').filter(
      (row) => row['channel'] === channel?.['id'],
    );
    expect(messages.length).toBeGreaterThan(5);
  });

  it.each(LANGS)('wiki (%s): every block is a type a page holds', (lang) => {
    const types = records('wiki', lang, 'page').flatMap((row) =>
      (row['blocks'] as { type: string }[]).map((block) => block.type),
    );
    expect(types.length).toBeGreaterThan(0);
    const known: readonly string[] = PAGE_BLOCK_TYPES;
    expect(types.filter((type) => !known.includes(type))).toEqual([]);
  });

  it.each(LANGS)('wiki (%s): pages on expenses exist to be quoted', (lang) => {
    const word = lang === 'ja' ? '経費' : 'xpense';
    const pages = records('wiki', lang, 'page').filter((row) =>
      JSON.stringify([row['title'], row['blocks']]).includes(word),
    );
    expect(pages.length).toBeGreaterThanOrEqual(3);
  });

  it.each(LANGS)(
    'quotation (%s): the customer it names has an earlier order for a similar part',
    (lang) => {
      const text = prompt('quotation', lang);
      const parts = records('quotation', lang, 'parts') as unknown as {
        customer: string;
        material: string;
      }[];
      expect(
        parts.some((part) => text.includes(part.customer) && text.includes(part.material)),
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Nothing real in a sample file
// ---------------------------------------------------------------------------------------------

/** Files a reader can scan for an address or number: text, not a binary the agent opens. */
const TEXT_FILE = /\.(?:md|json|txt|vtt|csv|ts|mjs|yaml)$/u;

function sampleFiles(entry: LiveEntry): string[] {
  const folders = [
    ...entry.demo.seed.map(({ from }) => path.join(sourceOf(entry), from)),
    ...(entry.demo.records === undefined ? [] : [path.join(sourceOf(entry), entry.demo.records)]),
  ];
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(full);
    }
  };
  for (const folder of folders) walk(folder);
  return found;
}

/** Addresses on a domain nobody owns (RFC 2606): `example.com`, `*.example`, `*.test`. */
const FICTIONAL_HOST = /^(?:example\.com|(?:[a-z0-9-]+\.)*example|(?:[a-z0-9-]+\.)*test)$/u;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gu;
/** Phone-like numbers: grouped digits with hyphens or spaces, and a leading `+` or `0`. */
const PHONE = /(?<![\d-])(?:\+\d{1,3}[ -])?0?\d{1,4}[ -]\d{2,4}[ -]\d{3,4}(?![\d-])/gu;
/**
 * A number a reviewed seed file already carries: the fictional store's support line in the
 * customer-inquiry FAQ, which the gallery's backend also holds as a constant (`PUBLIC_NUMBERS`), so
 * it cannot change in the sample file alone. A new entry here is a decision, not a convenience.
 */
const REVIEWED_PHONES: ReadonlySet<string> = new Set(['0120-555-310']);
/** The ranges set aside for fiction: `0000` as the exchange, or the `555-01xx` block. */
const FICTIONAL_PHONE = /(?:^|[ -])0000[ -]\d{4}$|555[ -]01\d\d$/u;

describe('every sample file', () => {
  const MAX = DEMO_SAMPLE_FILE_MAX_BYTES;

  it('is no larger than a sample file may be', () => {
    const tooLarge = live
      .flatMap((entry) => sampleFiles(entry))
      .filter((file) => statSync(file).size > MAX)
      .map((file) => path.relative(REPOSITORY_ROOT, file));
    expect(tooLarge).toEqual([]);
  });

  it('holds no email address outside example.com, .example and .test, and no real phone number', () => {
    const problems: string[] = [];
    for (const entry of live) {
      for (const file of sampleFiles(entry).filter((name) => TEXT_FILE.test(name))) {
        const text = readFileSync(file, 'utf8');
        const where = path.relative(REPOSITORY_ROOT, file);
        for (const match of text.matchAll(EMAIL)) {
          if (!FICTIONAL_HOST.test((match[1] ?? '').toLowerCase())) {
            problems.push(`${where}: email ${match[0]}`);
          }
        }
        for (const match of text.matchAll(PHONE)) {
          if (!FICTIONAL_PHONE.test(match[0]) && !REVIEWED_PHONES.has(match[0]))
            problems.push(`${where}: phone ${match[0]}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('is judged by checks that can fail: a real address and a real number are refused', () => {
    expect(FICTIONAL_HOST.test('example.com')).toBe(true);
    expect(FICTIONAL_HOST.test('aoba-seiki.example')).toBe(true);
    expect(FICTIONAL_HOST.test('mail.corp.test')).toBe(true);
    expect(FICTIONAL_HOST.test('kitano-seiki.co.jp')).toBe(false);
    expect(FICTIONAL_HOST.test('example.com.evil.net')).toBe(false);
    expect('03-1234-5678'.match(PHONE)?.[0]).toBe('03-1234-5678');
    expect(FICTIONAL_PHONE.test('03-1234-5678')).toBe(false);
    expect(FICTIONAL_PHONE.test('03-0000-5678')).toBe(true);
    expect(FICTIONAL_PHONE.test('+1 555-0123')).toBe(true);
    expect(FICTIONAL_PHONE.test('+1 415-555-2671')).toBe(false);
    expect('4800000 and 2026-10-02'.match(PHONE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The numbers on the card are the records' counts
// ---------------------------------------------------------------------------------------------

/** What `demo.data` says about each record file: the pattern that reads its count, by language. */
const COUNTED: Readonly<Record<string, readonly [file: string, ja: RegExp, en: RegExp][]>> = {
  'crm-sales': [
    ['company', /会社(\d+)社/u, /(\d+) fictional companies/u],
    ['contact', /担当者(\d+)名/u, /(\d+) contacts/u],
    ['deal', /商談(\d+)件/u, /(\d+) deals/u],
  ],
  'team-chat': [
    ['channel', /チャンネル(\d+)つ/u, /(\d+) channels/u],
    ['message', /メッセージ(\d+)件/u, /(\d+) messages/u],
  ],
  wiki: [
    ['space', /スペース(\d+)つ/u, /(\d+) spaces/u],
    ['page', /ページ(\d+)枚/u, /(\d+) pages/u],
  ],
  'service-desk': [
    ['ticket', /チケット(\d+)件/u, /(\d+) tickets/u],
    ['kb_article', /ナレッジ記事(\d+)本/u, /(\d+) knowledge articles/u],
  ],
  quotation: [
    ['parts', /部品(\d+)点/u, /(\d+) parts/u],
    ['orders', /過去受注(\d+)件/u, /(\d+) past orders/u],
    ['rates', /材料レート(\d+)種/u, /(\d+) material rates/u],
  ],
};

describe('what an entry with sample records says about its data', () => {
  it('names every one of its record files, and no entry that has none', () => {
    expect(Object.keys(COUNTED).sort()).toEqual(withRecords.map((entry) => entry.slug).sort());
    for (const entry of withRecords) {
      const files = readdirSync(recordsFolder(entry, 'ja')).map((file) =>
        path.basename(file, '.json'),
      );
      expect((COUNTED[entry.slug] ?? []).map(([file]) => file).sort()).toEqual(files.sort());
    }
  });

  it.each(withRecords.map((entry) => [entry.slug, entry] as const))(
    '%s: the counts in demo.data are the counts of the records, in both languages',
    (slug, entry) => {
      for (const lang of LANGS) {
        for (const [file, ja, en] of COUNTED[slug] ?? []) {
          const records = readJson(path.join(recordsFolder(entry, lang), `${file}.json`));
          const count = Array.isArray(records)
            ? records.length
            : Object.keys(records as object).length;
          const said = (lang === 'ja' ? ja : en).exec(entry.demo.data[lang])?.[1];
          expect(said, `${slug} ${file} (${lang}): demo.data says no count`).toBeDefined();
          expect(Number(said), `${slug} ${file} (${lang})`).toBe(count);
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// The counts of an entry whose data is sample files
// ---------------------------------------------------------------------------------------------

const filesUnder = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? filesUnder(path.join(folder, item.name)) : [path.join(folder, item.name)],
  );
const seededFiles = (entry: LiveEntry, collection?: string): string[] =>
  entry.demo.seed
    .filter((folder) => collection === undefined || folder.collection === collection)
    .flatMap((folder) => filesUnder(path.join(sourceOf(entry), folder.from)));
/** A document that ships as `.md` and `.pdf` is one document. */
const documents = (files: string[]): number =>
  new Set(files.map((file) => file.replace(/\.(?:md|pdf)$/u, ''))).size;

/** What `demo.data` counts for an entry whose seed is files, and how to count it from the files. */
const COUNTED_FILES: Readonly<
  Record<string, readonly [ja: RegExp, en: RegExp, count: (entry: LiveEntry) => number][]>
> = {
  'cad-drafting': [[/図面(\d+)枚/u, /(\d+) past drawings/u, (e) => seededFiles(e).length]],
  // The customer records (data/crm) are read through a connector the copy does not carry, so
  // the card does not count them as the demo's sample data.
  'customer-inquiry': [[/FAQ(\d+)本/u, /(\d+) FAQ articles/u, (e) => seededFiles(e).length]],
  'manual-search': [[/マニュアル(\d+)冊/u, /(\d+) manuals/u, (e) => documents(seededFiles(e))]],
  maintenance: [
    [/マニュアル(\d+)冊/u, /(\d+) equipment manuals/u, (e) => seededFiles(e, 'manuals').length],
    [/記録(\d+)件/u, /(\d+) trouble records/u, (e) => seededFiles(e, 'trouble-log').length],
    [/メモ(\d+)本/u, /(\d+) veteran notes/u, (e) => seededFiles(e, 'expert-notes').length],
  ],
  // The defect reports (data/defects) are read through the qms connector, whose reads the copy
  // does not carry, so the card does not count them as the demo's sample data.
  'quality-defect': [
    [/FMEAシート(\d+)冊/u, /(\d+) FMEA workbook/u, (e) => seededFiles(e, 'fmea').length],
  ],
  'ringi-review': [
    [/規程(\d+)本/u, /(\d+) rule documents/u, (e) => seededFiles(e, 'rules').length],
    [/稟議(\d+)ファイル/u, /(\d+) files of past ringi/u, (e) => seededFiles(e, 'ringi').length],
  ],
  'excel-consolidation': [
    // One folder per branch, the shared template folder apart.
    [/(\d+)拠点の/u, /from (\d+) branches/u, (e) => e.demo.seed.length - 1],
    [
      /Excel (\d+)ファイル/u,
      /(\d+) monthly sales-report/u,
      (e) =>
        seededFiles(e).filter(
          (file) =>
            !file.includes(`${path.sep}共通${path.sep}`) &&
            file.endsWith('.xlsx') &&
            /売上|月次/u.test(path.basename(file)),
        ).length,
    ],
  ],
  'meeting-minutes': [
    [/文字起こし(\d+)本/u, /(\d+) meeting transcripts/u, (e) => seededFiles(e).length],
  ],
};

describe('what an entry with sample files says about its data', () => {
  const counted = live.filter((entry) => COUNTED_FILES[entry.slug] !== undefined);

  it('covers every live entry that has sample files and no records, bar the ones with no count', () => {
    const seeded = live.filter((entry) => entry.demo.seed.length > 0).map((e) => e.slug);
    // contract-review's data is a document and a standard, not a count the card states.
    expect(Object.keys(COUNTED_FILES).sort()).toEqual(
      seeded.filter((slug) => slug !== 'contract-review').sort(),
    );
  });

  it.each(counted.map((entry) => [entry.slug, entry] as const))(
    '%s: the counts in demo.data are the counts of the files, in both languages',
    (slug, entry) => {
      for (const lang of LANGS) {
        for (const [ja, en, count] of COUNTED_FILES[slug] ?? []) {
          const said = (lang === 'ja' ? ja : en).exec(entry.demo.data[lang])?.[1];
          expect(said, `${slug} (${lang}): demo.data says no count`).toBeDefined();
          expect(Number(said), `${slug} (${lang}): ${entry.demo.data[lang]}`).toBe(count(entry));
        }
      }
    },
  );
});
