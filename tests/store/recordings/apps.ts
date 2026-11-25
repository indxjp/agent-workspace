/**
 * The app entries' recorders (crm, wiki, team-chat, service-desk). The agent is the entry's own
 * demo agent (`examples/<app>/agents/<demo.agent>`): its `mcp()` tools name the connector the
 * script may call, and its `engine.requireApproval` gates the calls the platform would pause for a
 * person. Its tools are the app's MCP endpoint answering as the person who asked (the platform's
 * identity assertion, ADR-0142), and its records are the app's own resources in the in-memory
 * stores `setAppRuntimeForTests` installs. Only the model's decisions are scripted, in a `Script`
 * that calls the tools exactly as the model would, and only the tools the agent declares.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { mcpEndpoint } from '@indx-workspace/app/server';
import {
  fakePerson,
  resetAppRuntimeForTests,
  setAppRuntimeForTests,
  type TestAppRuntime,
} from '@indx-workspace/app/testing';
import {
  IDENTITY_ASSERTION_HEADER,
  signIdentity,
} from '@indx-workspace/contracts/identity-assertion';
import type { DefinedAgent } from '@indx-workspace/sdk/define';
import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';
import { z } from 'zod';

import type { DefinedApp } from '@indx-workspace/app';
import { GALLERY_WORKSPACE_ID } from '../../gallery/harness/identity.ts';
import type { McpToolResult } from '../../gallery/harness/mcp-client.ts';
import { scriptedWorkspace, type Script } from '../../gallery/harness/scripted-workspace.ts';
import salesAssistant from '../../../examples/crm/agents/sales-assistant.ts';
import crmApp from '../../../examples/crm/app.config.ts';
import company from '../../../examples/crm/resources/company.ts';
import contact from '../../../examples/crm/resources/contact.ts';
import deal from '../../../examples/crm/resources/deal.ts';
import triage from '../../../examples/service-desk/agents/triage.ts';
import serviceDeskApp from '../../../examples/service-desk/app.config.ts';
import kbArticle from '../../../examples/service-desk/resources/kb_article.ts';
import ticket from '../../../examples/service-desk/resources/ticket.ts';
import helper from '../../../examples/team-chat/agents/helper.ts';
import teamChatApp from '../../../examples/team-chat/app.config.ts';
import channel from '../../../examples/team-chat/resources/channel.ts';
import message from '../../../examples/team-chat/resources/message.ts';
import writer from '../../../examples/wiki/agents/writer.ts';
import page from '../../../examples/wiki/resources/page.ts';
import space from '../../../examples/wiki/resources/space.ts';
import wikiApp from '../../../examples/wiki/app.config.ts';
import { playTurn } from './run.ts';
import type { Ask, Lang, Recorder } from './types.ts';

const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-0000000000a1';
const SECRET = 'store-recordings-app-secret';
/** The person who asks: a builder of the demo workspace. */
const PERSON = '6b1c1f0e-0000-4000-8000-0000000000b1';

const platform = fetchDouble(() =>
  jsonResponse(200, {
    memberships: [
      {
        id: '6b1c1f0e-0000-4000-8000-0000000000b2',
        principalId: PERSON,
        userId: '6b1c1f0e-0000-4000-8000-0000000000b3',
        email: 'visitor@example.test',
        name: 'A visitor',
        role: 'builder',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  }),
);

const MCP_RESPONSE = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ text: z.string() })),
  }),
});

/** Calls `name` on `app`'s MCP endpoint as `PERSON`, for the run `runId`. */
async function callApp(
  app: DefinedApp,
  runId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const assertion = await signIdentity(
    {
      sub: PERSON,
      principalKind: 'membership',
      workspace: GALLERY_WORKSPACE_ID,
      runId,
      aud: CONNECTOR_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    SECRET,
  );
  const response = await mcpEndpoint(app).POST(
    new Request('https://app.test/api/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        [IDENTITY_ASSERTION_HEADER]: assertion,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  );
  const { result } = MCP_RESPONSE.parse(await response.json());
  return {
    text: result.content.map((block) => block.text).join(''),
    isError: result.isError === true,
  };
}

export interface AppRecording {
  readonly ask: Ask;
  readonly app: DefinedApp;
  readonly appName: string;
  /** The entry's demo agent: its `mcp()` tools and `engine.requireApproval` are the run's. */
  readonly agent: DefinedAgent;
  /** The entry's sample tables, in the order their references need. */
  readonly tables: readonly Table[];
  readonly script: Script;
}

/** One sample table of an entry's `demo.records`: its file's name and how to create a record of it. */
interface Table {
  readonly name: string;
  readonly create: (
    runtime: TestAppRuntime,
    record: Record<string, unknown>,
  ) => Promise<{ id: string }>;
}

const RECORD_ROWS = z.array(z.record(z.string(), z.unknown()));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Put the entry's `demo.records` (the language of the ask) in `runtime`, as the person who owns
 * them. Each record is created in its table's order, so a reference to a record made earlier is
 * pointed at the new id; a reference to anyone who is not a record is a person, and is the visitor.
 * Fails with the entry's name when it has no records.
 */
async function seedRecords(ask: Ask, runtime: TestAppRuntime, tables: readonly Table[]) {
  if (ask.records === null) throw new Error(`${ask.slug} has no demo.records to record on`);
  const folder = path.join(ask.records, ask.lang);
  const loaded = tables.map((table) => ({
    table,
    rows: RECORD_ROWS.parse(
      JSON.parse(readFileSync(path.join(folder, `${table.name}.json`), 'utf8')),
    ),
  }));
  const recordIds = new Set(loaded.flatMap(({ rows }) => rows.map((row) => String(row['id']))));
  const made = new Map<string, string>();
  const point = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(point);
    if (typeof value !== 'string' || !UUID.test(value)) return value;
    return made.get(value) ?? (recordIds.has(value) ? value : PERSON);
  };
  for (const { table, rows } of loaded) {
    // A record may point at one of its own table made later (a page's parent): retry until all are made.
    let waiting = rows;
    while (waiting.length > 0) {
      const later: typeof rows = [];
      for (const row of waiting) {
        const { id, ...values } = row;
        const unmade = Object.values(values).some(
          (value) => typeof value === 'string' && recordIds.has(value) && !made.has(value),
        );
        if (unmade) {
          later.push(row);
          continue;
        }
        const pointed = Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, point(value)]),
        );
        made.set(String(id), (await table.create(runtime, pointed)).id);
      }
      if (later.length === waiting.length) {
        throw new Error(`${ask.slug}: ${table.name} records point at records that do not exist`);
      }
      waiting = later;
    }
  }
}

/** The connectors the agent declares with `mcp()`. */
const declaredConnectors = (agent: DefinedAgent): readonly string[] =>
  (agent.tools ?? []).flatMap((tool) => ('connector' in tool ? [tool.connector] : []));

/** The calls the platform pauses for a person: the agent's own `engine.requireApproval`. */
const gatedCalls = (agent: DefinedAgent): readonly string[] =>
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? (agent.engine.requireApproval ?? [])
    : [];

/** Plays the ask's prompt, as the entry's demo agent, in a workspace whose one connector is the app. */
async function recordApp(recording: AppRecording) {
  const { agent, ask } = recording;
  if (agent.name !== ask.agent) {
    throw new Error(
      `${ask.slug}: the recorder's agent "${agent.name}" is not demo.agent "${ask.agent}"`,
    );
  }
  const declared = declaredConnectors(agent);
  // The app is the agent's connector named after it; the agent may declare others (crm's email).
  const connector = declared.find((name) => name === recording.appName);
  if (connector === undefined) {
    throw new Error(
      `${ask.slug}: agent "${agent.name}" declares no mcp('${recording.appName}') tool`,
    );
  }
  // A clock that ticks a second per read, so records made in a row sort the same way every time.
  let tick = 0;
  const runtime = setAppRuntimeForTests({
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    appName: recording.appName,
    fetch: platform.fetch,
    workspaceId: GALLERY_WORKSPACE_ID,
    agentTools: {
      connectorId: CONNECTOR_ID,
      workspaceId: GALLERY_WORKSPACE_ID,
      identitySecrets: [SECRET],
      apiKey: 'app-machine-key-for-tests',
    },
  });
  try {
    await seedRecords(ask, runtime, recording.tables);
    // The model may call only what the agent declares: a tool of another connector is a false recording.
    const declaredOnly: Script = (context) =>
      recording.script({
        ...context,
        tool: (name, tool, args) => {
          if (!declared.includes(name)) {
            throw new Error(`${ask.slug}: agent "${agent.name}" does not declare mcp('${name}')`);
          }
          return context.tool(name, tool, args);
        },
      });
    const workspace = scriptedWorkspace(
      declaredOnly,
      {
        [connector]: {
          id: CONNECTOR_ID,
          session: {
            call: (name, args) => callApp(recording.app, 'run_recording', name, args),
          },
        },
      },
      {},
      { requireApproval: gatedCalls(agent) },
    );
    return await playTurn(workspace, ask);
  } finally {
    resetAppRuntimeForTests();
  }
}

const ITEMS = z.object({ items: z.array(z.record(z.string(), z.unknown())) });

/** The records a list or search tool answered. */
function itemsOf(result: McpToolResult): Record<string, unknown>[] {
  if (result.isError) throw new Error(`the app refused the call: ${result.text}`);
  return ITEMS.parse(JSON.parse(result.text)).items;
}

const text = (record: Record<string, unknown> | undefined, field: string): string =>
  z.string().catch('').parse(record?.[field]);

const say = <T>(lang: Lang, ja: T, en: T): T => (lang === 'ja' ? ja : en);

/** The owner of every sample record: an admin, so the visitor sees them as a member. */
const OWNER = fakePerson({
  role: 'admin',
  workspaceId: GALLERY_WORKSPACE_ID,
  principalId: '6b1c1f0e-0000-4000-8000-0000000000b4',
});

/** What a model reads out of the prompt: the first match of `pattern`, or the entry's name in the failure. */
function quoted(ask: Ask, pattern: RegExp): string {
  const found = pattern.exec(ask.prompt)?.[1];
  if (found === undefined)
    throw new Error(`${ask.slug} ${ask.lang}: the prompt has no ${String(pattern)}`);
  return found;
}

/** The agent tools read a page's body as markdown (`page_get`). */
const PAGE = z.object({ blocks: z.string() });
const MADE_PAGE = z.object({ title: z.string() });

export const APPS: Readonly<Record<string, Recorder>> = {
  'crm-sales': (ask) =>
    recordApp({
      ask,
      app: crmApp,
      appName: 'crm',
      agent: salesAssistant,
      tables: [
        {
          name: 'company',
          create: (runtime, record) => runtime.storeOf(company).create(OWNER, record),
        },
        {
          name: 'contact',
          create: (runtime, record) => runtime.storeOf(contact).create(OWNER, record),
        },
        { name: 'deal', create: (runtime, record) => runtime.storeOf(deal).create(OWNER, record) },
      ],
      script: async (context) => {
        const email = quoted(ask, /([\w.+-]+@[\w.-]+\.[a-z]+)/iu);
        const [found] = itemsOf(
          await context.tool('crm', 'contact_search', { q: email.split('@')[0] }),
        );
        const domain = email.split('@')[1] ?? '';
        const [match] = itemsOf(await context.tool('crm', 'company_search', { q: domain }));
        await context.tool('crm', 'contact_update', {
          id: text(found, 'id'),
          company: text(match, 'id'),
        });
        return say(
          ask.lang,
          `${text(found, 'name')}さんを${text(match, 'name')}にひも付けました。`,
          `Linked ${text(found, 'name')} to ${text(match, 'name')}`,
        );
      },
    }),

  'team-chat': (ask) =>
    recordApp({
      ask,
      app: teamChatApp,
      appName: 'team-chat',
      agent: helper,
      tables: [
        {
          name: 'channel',
          create: (runtime, record) => runtime.storeOf(channel).create(OWNER, record),
        },
        {
          name: 'message',
          create: (runtime, record) => runtime.storeOf(message).create(OWNER, record),
        },
      ],
      script: async (context) => {
        const name = quoted(ask, /#(\S+)/u);
        const [room] = itemsOf(await context.tool('team-chat', 'channel_search', { q: name }));
        const posts = itemsOf(await context.tool('team-chat', 'message_list', {})).filter(
          (post) => post['channel'] === room?.['id'],
        );
        const said = posts.map((post) => text(post, 'body'));
        // A model's reading of the thread: what was settled, and what is still a question.
        const decided = said.filter((line) => /決定|了解|Agreed/u.test(line));
        // A question is a post that asks: a "?", or the Japanese asks that carry none (どうでしょう。 意見をください。).
        const open = said.filter((line) =>
          say(ask.lang, /[？?]|どうでしょう|意見をください/u, /\?/u).test(line),
        );
        return say(
          ask.lang,
          [
            `#${text(room, 'name')} の今週（${String(posts.length)}件）`,
            '決まったこと:',
            ...decided.map((line) => `- ${line}`),
            'まだ決まっていないこと:',
            ...open.map((line) => `- ${line}`),
          ].join('\n'),
          [
            `This week in #${text(room, 'name')} (${String(posts.length)} messages)`,
            'Decided:',
            ...decided.map((line) => `- ${line}`),
            'Still open:',
            ...open.map((line) => `- ${line}`),
          ].join('\n'),
        );
      },
    }),

  wiki: (ask) =>
    recordApp({
      ask,
      app: wikiApp,
      appName: 'wiki',
      agent: writer,
      tables: [
        {
          name: 'space',
          create: (runtime, record) => runtime.storeOf(space).create(OWNER, record),
        },
        {
          name: 'page',
          create: (runtime, record) => runtime.pageStoreOf(page).create(OWNER, record),
        },
      ],
      script: async (context) => {
        const [source] = itemsOf(
          await context.tool('wiki', 'page_search', { q: say(ask.lang, '経費', 'expense') }),
        );
        const read = PAGE.parse(
          JSON.parse((await context.tool('wiki', 'page_get', { id: text(source, 'id') })).text),
        );
        const made = MADE_PAGE.parse(
          JSON.parse(
            (
              await context.tool('wiki', 'page_create', {
                parent: text(source, 'id'),
                space: text(source, 'space'),
                title: say(ask.lang, '新人向け: 経費精算', 'Expenses for new joiners'),
                markdown: read.blocks,
              })
            ).text,
          ),
        );
        return say(
          ask.lang,
          `「${text(source, 'title')}」を引用した新しいページ「${made.title}」の下書きを作りました。`,
          `Drafted "${made.title}", quoting "${text(source, 'title')}".`,
        );
      },
    }),

  'service-desk': (ask) =>
    recordApp({
      ask,
      app: serviceDeskApp,
      appName: 'service-desk',
      agent: triage,
      tables: [
        {
          name: 'kb_article',
          create: (runtime, record) => runtime.storeOf(kbArticle).create(OWNER, record),
        },
        {
          name: 'ticket',
          create: (runtime, record) => runtime.storeOf(ticket).create(OWNER, record),
        },
      ],
      script: async (context) => {
        const filed = quoted(ask, say(ask.lang, /「(.+?)」/u, /"(.+?)"/u));
        const [found] = itemsOf(await context.tool('service-desk', 'ticket_search', { q: filed }));
        // A model searches the knowledge base for the thing the ticket is about: the device (a
        // katakana word in Japanese, where the search reads kana and kanji, not a Latin word glued to them) or the standard (an acronym).
        const about = say(ask.lang, /[ァ-ヶー]{3,}/u, /\b[A-Z]{3,}\b/u).exec(
          `${text(found, 'title')} ${text(found, 'description')}`,
        )?.[0];
        const searched = itemsOf(
          await context.tool('service-desk', 'kb_article_search', { q: about ?? filed }),
        );
        // The search matches whole words, and Japanese text has no spaces between them: when it finds
        // nothing a model reads the articles' list for the one that mentions the thing.
        const [article] =
          searched.length > 0 || about === undefined
            ? searched
            : itemsOf(await context.tool('service-desk', 'kb_article_list', {})).filter((item) =>
                `${text(item, 'title')} ${text(item, 'body')}`.includes(about),
              );
        // Priority and status are what the prompt asks for (people are ids, so it names no owner).
        await context.tool('service-desk', 'ticket_update', {
          id: text(found, 'id'),
          status: 'in_progress',
          priority: 'p2',
        });
        const title = text(article, 'title');
        return title === ''
          ? say(
              ask.lang,
              '優先度をp2にして対応中にしました。該当するナレッジ記事は見つかりませんでした。',
              'Set priority p2 and marked it in progress. No knowledge article matched.',
            )
          : say(
              ask.lang,
              `優先度をp2にして対応中にしました。ナレッジ記事「${title}」を添えます。`,
              `Set priority p2 and marked it in progress. Attach the article "${title}".`,
            );
      },
    }),
};
