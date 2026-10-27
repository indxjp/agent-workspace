#!/usr/bin/env node
/* global process, URL */ // The root ESLint config declares no environment globals.
// A stand-in for the company QMS (quality management system) API, serving the past-trouble (過去トラ)
// reports in `data/defects/*.json` exactly as `apis/qms.openapi.json` describes it, on loopback. The
// tests start it; for a local demo:
//
//   QMS_TOKEN=dev-token QMS_IDENTITY_SECRET=... IDENTITY_AUDIENCE=<tool-id> IDENTITY_WORKSPACE=<workspace-id> \
//     PORT=8790 node qms/fake-qms.mjs
//
// It reads one JSON file per past defect report, as a quality system exports them (不具合番号,
// 品番, 工程, 現象, 原因, 4M分類, 対策, 水平展開, 再発有無 …), and answers four operations:
//
//   GET  /defects?q&process&partNo   searchDefects  similar past cases, best first, or { noMatch, message }
//   GET  /defects/{qNo}              getDefect      one report in full, with its citation
//   GET  /defects/stats?q&process…   causeStats     4M counts over every matched case
//   POST /defects                    createCase     the approved 8D as a new 過去トラ
//
// Every request needs `Authorization: Bearer <token>`, as the real QMS would, so a test can show the
// credential the tool gateway presents is the tool's, not the caller's.
//
// `causeStats` exists so that the agent never counts. "機械 3件" in an 8D draft is a number a
// reviewer acts on; the QMS computes it deterministically and returns the exact line to quote, and
// the backend checks that the line in the draft is one this operation returned in the same run.
//
// Who may see which cases (ADR-0142). The tool opts in with `identity: secret(...)`, so each call also
// carries a signed `x-aw-identity` header; the QMS verifies it with `verifyIdentity` and answers
// `401 { code }` for a missing or bad one. `data/access.json` maps the asserted `sub` to the 工程
// whose past cases that person may see. A case of another 工程 is never searched, counted or read,
// and reading it is refused in the same words as a case that does not exist, so the 4M counts quoted
// in a draft are over what that person may see.
//
// The one write is `POST /defects` (`createCase`): it registers the approved 8D under the 工程 of the
// person who entered the defect and answers 201 with the new Q-number. It is logged in `requests`
// with its parsed body, so a test can show what reached the QMS and, as important, that nothing did
// before an approval. A registered case is read by `getDefect` at once; the search index is built when
// the QMS starts, so a new case is found by search after the next start (the nightly reindex).
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IDENTITY_ASSERTION_HEADER, verifyIdentity } from '@indx-workspace/sdk';

import { createIndex } from '../../shared/jp-search.mjs';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const BASE_PATH = '/api/v1';

const PROCESSES = ['プレス', '溶接', '塗装', '組立'];
const FOUR_M = ['人', '機械', '材料', '方法'];
const ID = /^Q-\d{4}$/u;
const PART_NO = /^[A-Z]{3}-\d{4}$/u;
const SEARCH_LIMIT = 8;
// What the agent answers, word for word, when nothing matches above the coverage threshold: the
// QMS says it, so the reply does not depend on the model recalling the sentence.
const NO_MATCH =
  '類似する過去トラは見つかりませんでした。品質保証課で新規不具合として登録してください。';

/** A request the QMS refuses with `status`; the message is what the agent reads. */
class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const badRequest = (message) => new Refusal(400, message);

/** One exported report → the record the operations serve, with English keys and its citation. */
function recordOf(raw) {
  const fourM = raw['4M分類'];
  if (!FOUR_M.includes(fourM)) throw new Error(`${raw['不具合番号']}: unknown 4M ${fourM}`);
  return {
    id: raw['不具合番号'],
    partNo: raw['品番'],
    partName: raw['品名'],
    process: raw['工程'],
    phenomenon: raw['現象'],
    date: raw['発生日'],
    lot: raw['ロット'],
    count: raw['発生数'],
    outflow: raw['流出区分'],
    cause: raw['原因'],
    causeCode: raw['原因区分'],
    fourM,
    whys: raw['なぜなぜ'],
    countermeasure: raw['対策'],
    horizontalDeployment: raw['水平展開'],
    recurred: raw['再発有無'],
    related: raw['関連不具合'],
    citation: `〔過去トラ ${raw['不具合番号']}〕`,
  };
}

const summaryOf = (hit) => ({
  id: hit.id,
  partNo: hit.partNo,
  process: hit.process,
  phenomenon: hit.phenomenon,
  date: hit.date,
  causeCode: hit.causeCode,
  fourM: hit.fourM,
  recurred: hit.recurred,
  cause: hit.cause,
  citation: hit.citation,
  score: hit.score,
});

/** 4M counts over the matched cases, in a fixed key order, and the line the draft must quote. */
function causeStatsOf(hits) {
  const fourM = Object.fromEntries(FOUR_M.map((key) => [key, 0]));
  const causes = new Map();
  for (const hit of hits) {
    fourM[hit.fourM] += 1;
    const entry = causes.get(hit.causeCode) ?? {
      causeCode: hit.causeCode,
      fourM: hit.fourM,
      count: 0,
      recurred: 0,
      ids: [],
    };
    entry.count += 1;
    if (hit.recurred === '有') entry.recurred += 1;
    entry.ids.push(hit.id);
    causes.set(hit.causeCode, entry);
  }
  const ids = hits.map((hit) => hit.id).sort();
  for (const entry of causes.values()) entry.ids.sort();
  const byCause = [...causes.values()].sort(
    (left, right) => right.count - left.count || (left.causeCode < right.causeCode ? -1 : 1),
  );
  const counts = FOUR_M.map((key) => `${key} ${String(fourM[key])}件`).join(' / ');
  return {
    matched: hits.length,
    fourM,
    byCause,
    ids,
    line: `4M集計: ${counts}（類似 ${String(hits.length)}件）`,
  };
}

const readBody = async (request) => {
  request.setEncoding('utf8');
  let text = '';
  for await (const chunk of request) text += chunk;
  return text;
};

/** A required non-blank string field of the request body, trimmed, or a 400 naming it. */
function required(body, key) {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${key} must be a non-empty string`);
  }
  return value.trim();
}

/** A required non-empty array of non-blank strings, or a 400 naming it. */
function lines(body, key) {
  const value = body[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((line) => typeof line !== 'string' || line.trim() === '')
  ) {
    throw badRequest(`${key} must be a non-empty array of strings`);
  }
  return value.map((line) => line.trim());
}

/**
 * Start the fake QMS. Resolves with its base URL (ending in `/api/v1`), the `requests` it received and
 * a `close()`. `identity` is what verifies the caller: `{ key, audience, workspace }`, `key` a string
 * or a list while it rotates. `dataDir` holds `defects/*.json` and `access.json`.
 */
export function startFakeQms({ token, identity, port = 0, dataDir = DATA_DIR }) {
  const access = JSON.parse(readFileSync(path.join(dataDir, 'access.json'), 'utf8'));
  const defectsDir = path.join(dataDir, 'defects');
  const records = readdirSync(defectsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => recordOf(JSON.parse(readFileSync(path.join(defectsDir, name), 'utf8'))));
  const byId = new Map(records.map((record) => [record.id, record]));
  // The phenomenon is the title, so it carries the most weight; the cause and its category let a
  // query such as 「金型摩耗」 find cases whose phenomenon differs.
  const index = createIndex(
    records.map((record) => ({
      ...record,
      title: `${record.phenomenon} ${record.phenomenon}`,
      text: `${record.partName} ${record.causeCode} ${record.cause}`,
    })),
  );
  const requests = [];

  /** The optional filters both searches take, validated, and the 工程 the caller may see. */
  function filtersOf(params, processes) {
    const process = params.get('process');
    if (process !== null && !PROCESSES.includes(process)) {
      throw badRequest(`process must be one of ${PROCESSES.join(' / ')}`);
    }
    const partNo = params.get('partNo');
    if (partNo !== null && partNo.trim() === '')
      throw badRequest('partNo must be a non-empty string');
    const prefix = partNo === null ? null : partNo.trim().toUpperCase();
    return (record) =>
      processes.includes(record.process) &&
      (process === null || record.process === process) &&
      (prefix === null || record.partNo.startsWith(prefix));
  }

  function matches(params, max, processes) {
    const q = (params.get('q') ?? '').trim();
    if (q === '') throw badRequest('q must be a non-empty string');
    return index.search(q, { limit: max, filter: filtersOf(params, processes), minCoverage: 0.5 });
  }

  /** Register the approved 8D as a new 過去トラ in a 工程 the caller may see. */
  function register(body, processes) {
    const process = required(body, 'process');
    if (!PROCESSES.includes(process)) {
      throw badRequest(`process must be one of ${PROCESSES.join(' / ')}`);
    }
    if (!processes.includes(process)) {
      throw new Refusal(403, 'no access: this caller may not register a case of this process');
    }
    const partNo = required(body, 'partNo').toUpperCase();
    if (!PART_NO.test(partNo)) throw badRequest('partNo must look like BRK-2201');
    const fourM = required(body, 'fourM');
    if (!FOUR_M.includes(fourM)) throw badRequest(`fourM must be one of ${FOUR_M.join(' / ')}`);
    if (!Number.isInteger(body.count) || body.count < 1) {
      throw badRequest('count must be a positive integer');
    }
    const next = Math.max(0, ...[...byId.keys()].map((key) => Number(key.slice(2)))) + 1;
    if (next > 9999) throw badRequest('no Q-number left');
    const id = `Q-${String(next).padStart(4, '0')}`;
    const record = recordOf({
      不具合番号: id,
      品番: partNo,
      品名: partNo,
      工程: process,
      現象: required(body, 'title'),
      発生日: new Date().toISOString().slice(0, 10),
      ロット: required(body, 'lot'),
      発生数: body.count,
      流出区分: null,
      原因: required(body, 'cause'),
      原因区分: required(body, 'causeCode'),
      '4M分類': fourM,
      なぜなぜ: lines(body, 'whys'),
      対策: required(body, 'countermeasure'),
      水平展開: required(body, 'horizontalDeployment'),
      再発有無: '無',
      関連不具合: [],
      '8D': required(body, 'report'),
    });
    byId.set(id, record);
    return { qNo: id, citation: record.citation };
  }

  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://qms.invalid');
    const entry = { method: request.method, path: url.pathname + url.search };
    requests.push(entry);
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: 'unauthorized' });
      return;
    }
    if (
      request.method !== 'GET' &&
      !(request.method === 'POST' && url.pathname === `${BASE_PATH}/defects`)
    ) {
      send(405, { error: 'method not allowed' });
      return;
    }
    const caller = await verifyIdentity(
      request.headers[IDENTITY_ASSERTION_HEADER] ?? '',
      identity.key,
      new Date(),
      { audience: identity.audience, workspace: identity.workspace },
    );
    if (!caller.ok) {
      send(401, { code: caller.code });
      return;
    }
    if (!Object.hasOwn(access, caller.payload.sub)) {
      send(403, { error: 'no access: this caller is not registered for this API' });
      return;
    }
    const { processes } = access[caller.payload.sub];
    try {
      if (request.method === 'POST') {
        let body;
        try {
          body = JSON.parse(await readBody(request));
        } catch {
          throw badRequest('the body must be JSON');
        }
        entry.body = body;
        entry.by = caller.payload.sub;
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw badRequest('the body must be a JSON object');
        }
        send(201, register(body, processes));
        return;
      }
      const route = url.pathname.startsWith(`${BASE_PATH}/`)
        ? url.pathname.slice(BASE_PATH.length)
        : null;
      if (route === '/defects') {
        const hits = matches(url.searchParams, SEARCH_LIMIT, processes);
        send(200, hits.length === 0 ? { noMatch: true, message: NO_MATCH } : hits.map(summaryOf));
        return;
      }
      if (route === '/defects/stats') {
        const groupBy = url.searchParams.get('groupBy');
        if (groupBy !== null && groupBy !== '4m') throw badRequest('groupBy must be 4m');
        send(200, {
          query: (url.searchParams.get('q') ?? '').trim(),
          process: url.searchParams.get('process'),
          partNo: url.searchParams.get('partNo'),
          ...causeStatsOf(matches(url.searchParams, records.length, processes)),
        });
        return;
      }
      const defect = /^\/defects\/([^/]+)$/u.exec(route ?? '');
      if (defect) {
        const id = decodeURIComponent(defect[1]).toUpperCase();
        if (!ID.test(id)) throw badRequest('qNo must look like Q-1234');
        const record = byId.get(id);
        if (record === undefined || !processes.includes(record.process)) {
          throw new Refusal(404, `no past defect ${id}; call searchDefects first`);
        }
        send(200, {
          ...record,
          related: record.related.filter((other) => processes.includes(byId.get(other)?.process)),
        });
        return;
      }
      send(404, { error: 'no such route' });
    } catch (error) {
      if (!(error instanceof Refusal)) {
        send(500, { error: 'internal error' });
        return;
      }
      send(error.status, { error: error.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}${BASE_PATH}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const qms = await startFakeQms({
    token: process.env.QMS_TOKEN ?? 'dev-token',
    identity: {
      key: (process.env.QMS_IDENTITY_SECRET ?? '').split(','),
      audience: process.env.IDENTITY_AUDIENCE ?? '',
      workspace: process.env.IDENTITY_WORKSPACE ?? '',
    },
    port: Number(process.env.PORT ?? 8790),
  });
  process.stdout.write(`fake QMS on ${qms.url}\n`);
}
