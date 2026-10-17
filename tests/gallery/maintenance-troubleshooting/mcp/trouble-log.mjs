/* global process */ // The root ESLint config declares no environment globals.
// trouble-log: the plant's past trouble records (過去トラ) and the retiring experts' interview notes
// (熟練者メモ), searchable and writable, as an MCP server.
//
//   search_troubles { machineId?, symptom, limit? } → past troubles on that machine first, then on
//                                                     machines of the same model; expert notes
//   get_trouble     { id }                          → one record in full, with the citation to copy
//   log_resolution  { machineId, symptom, cause, action, technician, durationMin? }
//                                                   → appends a resolved case to the store
//
// The last tool is why this is your own server. An agent's file grant is not a database, and an
// openapiTool() may only call GET/HEAD, so the one supported way for an agent to write a record
// into the maintenance system is a tool you host and validate. Records it writes are marked
// `reviewed: false` until an expert reviews them.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIndex, normalise } from '../../shared/jp-search.mjs';
import { limit, refuse, serveTools, text } from '../../shared/mcp-server.mjs';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const TROUBLE_DIR = process.env.TROUBLE_LOG_DIR ?? path.join(DATA_DIR, 'trouble-log');
const NOTES_DIR = process.env.EXPERT_NOTES_DIR ?? path.join(DATA_DIR, 'expert-notes');
/** Where log_resolution writes. Unset, the server is read-only and says so. */
const STORE = process.env.TROUBLE_LOG_STORE;

const FIELD_MAX = 300;
const TECHNICIAN_MAX = 40;

// ---------------------------------------------------------------------------------------------
// Machines and records

const machineFiles = readdirSync(TROUBLE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(path.join(TROUBLE_DIR, name), 'utf8')));

const machines = machineFiles.map(({ machineId, name, model, line }) => ({
  machineId,
  name,
  model,
  line,
}));

/** A machine by its id (PR-02) or its floor name (プレス2号機, ﾌﾟﾚｽ２号機), or undefined. */
function findMachine(value) {
  const wanted = normalise(value).replace(/\s/gu, '');
  return machines.find(
    (machine) =>
      normalise(machine.machineId).replace(/\s/gu, '') === wanted ||
      normalise(machine.name).replace(/\s/gu, '') === wanted,
  );
}

const NO_RECORD_HANDOFF =
  'この設備の過去トラ・マニュアルは登録されていません。熟練者に引き継ぎます。';

function requireMachine(args, handoff = '') {
  const machine = findMachine(text(args, 'machineId'));
  if (machine === undefined) {
    refuse(
      `unknown machineId; known machines: ${machines.map((m) => `${m.machineId} ${m.name}`).join(', ')}${handoff}`,
    );
  }
  return machine;
}

const fixtureRecords = machineFiles.flatMap((file) =>
  file.records.map((record) => ({ ...record, machineId: file.machineId, reviewed: true })),
);

function storedRecords() {
  if (STORE === undefined || !existsSync(STORE)) return [];
  return JSON.parse(readFileSync(STORE, 'utf8'));
}

function allRecords() {
  const machineOf = new Map(machines.map((machine) => [machine.machineId, machine]));
  return [...fixtureRecords, ...storedRecords()].map((record) => {
    const machine = machineOf.get(record.machineId);
    return { ...record, machineName: machine?.name ?? null, model: machine?.model ?? null };
  });
}

const citationOf = (record) => `〔過去トラ ${record.id}〕`;

function view(record, match) {
  return {
    id: record.id,
    machineId: record.machineId,
    machineName: record.machineName,
    date: record.date,
    symptom: record.symptom,
    cause: record.cause,
    action: record.action,
    durationMin: record.durationMin,
    technician: record.technician,
    reviewed: record.reviewed,
    ...(match === undefined ? {} : { match }),
    citation: citationOf(record),
  };
}

// ---------------------------------------------------------------------------------------------
// Expert notes: one passage per `## §N heading` section.

function notePassages(fileName, markdown) {
  const front = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  const meta = Object.fromEntries(
    (front?.[1] ?? '').split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  const models = (meta.models ?? '').split(',').map((model) => model.trim());
  const passages = [];
  let current = null;
  for (const line of markdown.slice(front?.[0].length ?? 0).split('\n')) {
    const heading = /^## §(\S+)\s+(.+)$/u.exec(line);
    if (heading) {
      current = {
        id: `${path.parse(fileName).name}#${heading[1]}`,
        author: meta.author ?? fileName,
        models,
        section: heading[1],
        title: heading[2],
        lines: [],
      };
      passages.push(current);
      continue;
    }
    if (current && line.trim() !== '') current.lines.push(line.trim());
  }
  return passages.map(({ lines, ...passage }) => ({ ...passage, text: lines.join('') }));
}

const notes = readdirSync(NOTES_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .flatMap((name) => notePassages(name, readFileSync(path.join(NOTES_DIR, name), 'utf8')));
const noteIndex = createIndex(notes);

// ---------------------------------------------------------------------------------------------
// Tools

function searchTroubles(args) {
  const symptom = text(args, 'symptom');
  const max = limit(args, 'limit', 5, 10);
  const machine =
    args.machineId === undefined
      ? undefined
      : requireMachine(
          args,
          `。この設備の記録はありません。machineId を外して検索し直さず、【安全】の行のあとに次の1行だけを書いて返す: ${NO_RECORD_HANDOFF}`,
        );
  const records = allRecords();
  const index = createIndex(
    records.map((record) => ({ ...record, text: `${record.symptom} ${record.cause}` })),
  );

  let troubles;
  if (machine === undefined) {
    troubles = index.search(symptom, { limit: max }).map((hit) => view(hit, 'any'));
  } else {
    // The machine's own history first; then its siblings of the same model, which share the
    // hydraulics and so the causes. A different model with a similar symptom is not evidence.
    const own = index
      .search(symptom, { limit: max, filter: (record) => record.machineId === machine.machineId })
      .map((hit) => view(hit, 'same-machine'));
    const sibling = index
      .search(symptom, {
        limit: max,
        filter: (record) =>
          record.model === machine.model && record.machineId !== machine.machineId,
      })
      .map((hit) => view(hit, 'same-model'));
    troubles = [...own, ...sibling].slice(0, max);
  }

  const expertNotes = noteIndex
    .search(symptom, {
      limit: 3,
      minCoverage: 1 / 4,
      filter: (note) => machine === undefined || note.models.includes(machine.model),
    })
    .map((note) => ({
      id: note.id,
      author: note.author,
      heading: note.title,
      text: note.text,
      citation: `〔熟練者メモ ${note.author} §${note.section}〕`,
    }));

  return { machine: machine ?? null, troubles, expertNotes };
}

function getTrouble(args) {
  const id = text(args, 'id');
  if (!/^T-\d{4}$/u.test(id)) refuse('id must look like T-0001');
  const record = allRecords().find((candidate) => candidate.id === id);
  if (record === undefined) refuse(`no trouble record ${id}; call search_troubles first`);
  return view(record);
}

function field(args, key, max) {
  const value = text(args, key);
  if ([...value].length > max) refuse(`${key} must be at most ${max} characters`);
  return value;
}

function logResolution(args) {
  if (STORE === undefined) refuse('this server has no TROUBLE_LOG_STORE; it cannot write records');
  const machine = requireMachine(args);
  const symptom = field(args, 'symptom', FIELD_MAX);
  const cause = field(args, 'cause', FIELD_MAX);
  const action = field(args, 'action', FIELD_MAX);
  const technician = field(args, 'technician', TECHNICIAN_MAX);
  const durationMin = args.durationMin;
  if (
    durationMin !== undefined &&
    (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 1440)
  ) {
    refuse('durationMin must be an integer from 1 to 1440');
  }

  const stored = storedRecords();
  const highest = Math.max(
    ...[...fixtureRecords, ...stored].map((record) => Number(record.id.slice(2))),
  );
  const record = {
    id: `T-${String(highest + 1).padStart(4, '0')}`,
    date: new Date().toISOString().slice(0, 10),
    machineId: machine.machineId,
    symptom,
    cause,
    action,
    durationMin: durationMin ?? null,
    technician,
    // An expert reviews every agent-logged case before it counts as a known cause.
    reviewed: false,
  };
  // Write the whole file to a sibling and rename it over the store, so a crash never leaves half
  // a JSON array behind.
  const temporary = `${STORE}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify([...stored, record], null, 2)}\n`);
  renameSync(temporary, STORE);
  return { ...view({ ...record, machineName: machine.name }), logged: true };
}

serveTools({
  name: 'trouble-log',
  tools: [
    {
      name: 'search_troubles',
      description:
        '過去トラ（過去のトラブル記録）と熟練者メモを現象で検索する。machineId（設備番号 PR-02 または設備名 プレス2号機）を渡すと、その設備の記録を先に、次に同じ機種の別設備の記録を返す。',
      inputSchema: {
        type: 'object',
        properties: {
          machineId: { type: 'string' },
          symptom: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['symptom'],
      },
      handler: searchTroubles,
    },
    {
      name: 'get_trouble',
      description: '過去トラ1件（T-0001 形式の id）を全文で読む。手順に引用する前に必ず読む。',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: getTrouble,
    },
    {
      name: 'log_resolution',
      description:
        '解決したトラブルを過去トラに記録する。技術者が「直った」と確認してから1回だけ呼ぶ。記録は熟練者のレビュー待ち（reviewed: false）になる。',
      inputSchema: {
        type: 'object',
        properties: {
          machineId: { type: 'string' },
          symptom: { type: 'string' },
          cause: { type: 'string' },
          action: { type: 'string' },
          technician: { type: 'string' },
          durationMin: { type: 'integer', minimum: 1, maximum: 1440 },
        },
        required: ['machineId', 'symptom', 'cause', 'action', 'technician'],
      },
      handler: logResolution,
    },
  ],
});
