/* global process */ // The root ESLint config declares no environment globals.
// crm-history: the customer's interaction history and the public FAQ, as an MCP server.
//
//   search_history  { customerId, token, query, limit? } → that customer's matching interactions
//   get_interaction { customerId, token, id }            → one interaction in full
//   search_faq      { query, limit? }                    → FAQ answers (public, no token)
//
// Two rules the server enforces itself, because nothing upstream does:
//
// 1. Customer scope. A connector's credential is the agent's, not the visitor's (RF-102), so the
//    server cannot learn who is chatting from the connection. Every history call carries the
//    signed token the chat backend minted for this conversation (../lib/customer-token.mjs); the
//    call is refused unless the token verifies, has not expired, and names `customerId`. An id
//    from another customer's history is refused with the same words as an id that does not exist,
//    so the refusal does not confirm that it exists.
// 2. Personal data. Agent Workspace does not redact tool results, so every string the server
//    returns is masked (../lib/pii.mjs): phone numbers, e-mail addresses, postal codes and street
//    addresses become ［電話番号］, ［メール］, ［郵便番号］, ［住所］. The customer record's own
//    phone, e-mail and address are never returned as fields at all.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIndex } from '../../shared/jp-search.mjs';
import { limit, refuse, serveTools, text } from '../../shared/mcp-server.mjs';
import { verifyCustomerToken } from '../lib/customer-token.mjs';
import { maskDeep } from '../lib/pii.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRM_DIR = process.env.CRM_DIR ?? path.join(HERE, '..', 'data', 'crm');
const FAQ_DIR = process.env.FAQ_DIR ?? path.join(HERE, '..', 'data', 'faq');
// Shared with the chat backend, never with the model. Without it no history call succeeds.
const SECRET = process.env.CRM_TOKEN_SECRET ?? '';
/** The company's own numbers, which may appear in answers. */
const PUBLIC_NUMBERS = ['0120-555-310'];

const jsonFiles = (dir, extension) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8') }));

const customers = new Map(
  jsonFiles(CRM_DIR, '.json').map(({ text: body }) => {
    const record = JSON.parse(body);
    return [record.customerId, record];
  }),
);
const interactions = [...customers.values()].flatMap((customer) =>
  customer.interactions.map((entry) => ({
    ...entry,
    customerId: customer.customerId,
    title: entry.subject,
    text: `${entry.channel} ${entry.body} ${entry.outcome}`,
  })),
);
const history = createIndex(interactions);
const interactionById = new Map(interactions.map((entry) => [entry.id, entry]));

function faqPassages() {
  return jsonFiles(FAQ_DIR, '.md').flatMap(({ name, text: markdown }) => {
    const source = /^title:\s*(.+)$/mu.exec(markdown)?.[1] ?? name;
    return markdown
      .split(/^## /mu)
      .slice(1)
      .map((block) => {
        const [heading = '', ...lines] = block.split('\n');
        const [number = '', ...title] = heading.trim().split(/\s+/u);
        return {
          id: `${path.parse(name).name}#${number}`,
          source,
          title: title.join(' '),
          text: lines.join('').trim(),
        };
      });
  });
}
const faq = createIndex(faqPassages());

/** Verify the call's token and return the customer it may see. */
function customerFor(args) {
  const customerId = text(args, 'customerId');
  const check = verifyCustomerToken(SECRET, args.token);
  if (!check.ok) {
    refuse(
      check.reason === 'expired'
        ? 'customer token expired: ask the customer to reload the chat; do not guess their history'
        : 'customer token invalid: answer from the FAQ only, or hand off to an operator',
    );
  }
  if (check.customerId !== customerId) {
    refuse('this token is not for that customer: you may only read the signed-in customer');
  }
  const customer = customers.get(customerId);
  if (customer === undefined) refuse('no such customer');
  return customer;
}

/** Mask the customer's own values verbatim and every pattern, leaving the company's numbers. */
const masked = (customer, value) =>
  maskDeep(value, {
    known: [customer.phone, customer.email, customer.address],
    allow: PUBLIC_NUMBERS,
  });

const summary = ({ id, date, channel, subject, body, outcome }) => ({
  id,
  date,
  channel,
  subject,
  snippet: body.slice(0, 60),
  outcome,
});

const tokenProperties = {
  customerId: { type: 'string', description: 'プロンプトの【顧客セッション】にある customerId' },
  token: { type: 'string', description: 'プロンプトの【顧客セッション】にある token をそのまま' },
};

serveTools({
  name: 'crm-history',
  tools: [
    {
      name: 'search_history',
      description:
        'ログイン中のお客様の問い合わせ・注文履歴（チケット、メール、電話メモ、注文）を全文検索する。新しい順ではなく関連度順。個人情報は伏せ字で返る。見つからなければ空配列。',
      inputSchema: {
        type: 'object',
        properties: {
          ...tokenProperties,
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['customerId', 'token', 'query'],
      },
      handler: (args) => {
        const customer = customerFor(args);
        const hits = history.search(text(args, 'query'), {
          limit: limit(args, 'limit', 5, 10),
          filter: (entry) => entry.customerId === customer.customerId,
          minCoverage: 0.25,
        });
        // Mask the whole text before cutting the snippet, or a cut could split a number in two
        // and leave half of it unmasked (〒154-001…).
        return hits.map((hit) => ({ ...summary(masked(customer, hit)), score: hit.score }));
      },
    },
    {
      name: 'get_interaction',
      description:
        'search_history が返した id の履歴を全文で読む。ログイン中のお客様の履歴だけが読める。個人情報は伏せ字で返る。',
      inputSchema: {
        type: 'object',
        properties: { ...tokenProperties, id: { type: 'string' } },
        required: ['customerId', 'token', 'id'],
      },
      handler: (args) => {
        const customer = customerFor(args);
        const entry = interactionById.get(text(args, 'id'));
        // Same words for "not yours" and "not there": the refusal must not confirm the id exists.
        if (entry?.customerId !== customer.customerId) {
          refuse("no interaction with that id in this customer's history");
        }
        const { id, date, channel, subject, body, outcome } = entry;
        return masked(customer, { id, date, channel, subject, body, outcome });
      },
    },
    {
      name: 'search_faq',
      description:
        'よくあるご質問（返品・交換・返金、配送、会員・定期便）を全文検索する。お客様の個人情報は含まない。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: ['query'],
      },
      handler: (args) =>
        faq
          .search(text(args, 'query'), { limit: limit(args, 'limit', 3, 5) })
          .map(({ id, source, title, text: answer, score }) => ({
            id,
            source,
            title,
            answer,
            score,
          })),
    },
  ],
});
