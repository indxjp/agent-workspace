/**
 * The stand-in a demo agent's connector is replaced by when the entry has sample records (internal
 * spec, "How Try it works"). Like `fake-send-server.ts` it is an MCP server on standard input and
 * output with no network, file or process code at all, one plain string. It answers:
 *
 * - each read tool the seed names with that tool's record sets: the records of every set, in both
 *   languages, each tagged with its language (`lang`), narrowed by the call's arguments, after the
 *   records the platform kept for an approved write that this read answers with (newest first);
 * - each recorded write (ADR-0169) with what the platform kept for a call with the same arguments:
 *   the record, or a typed refusal (`DemoRecordWriteAnswer`); a call nothing was kept for is
 *   refused with `demo_write_not_recorded` and changes nothing;
 * - every other write tool with `DEMO_SEND_RESULT`, doing nothing, as `fake-send-server.ts` does;
 * - each read whose record set is a public-source snapshot (resource
 *   `PUBLIC_SOURCE_RECORDS_RESOURCE`, ADR-0170 D4) with the snapshot's answer, by the SDK's own
 *   answer function (`PUBLIC_SOURCE_SNAPSHOT_SCRIPT`), so it answers as the installed tool does.
 *
 * The stand-in never keeps anything itself: the platform writes an approved call's outcome into
 * the stand-in's arguments before the continuation run starts (`../records`), so a process that
 * runs for one run reads it from there. The state travels in the connector's arguments (the copy
 * has no file for the stand-in to read), as JSON split into pieces small enough for one argument.
 * Narrowing: a string argument named `query`, `q`, `search` or `text` keeps the records whose text
 * holds it (case ignored); any other string argument keeps the records whose field of that name
 * equals it (case ignored), and is ignored by a record with no such field; a `limit` argument cuts
 * the answer. A call never gets more than {@link RECORDS_PER_ANSWER} records.
 */
import { DEMO_SEND_RESULT } from '@indx-workspace/contracts/demo';
import {
  DEMO_RECORD_ISSUES_MAX,
  DEMO_RECORD_SCHEMAS,
  DEMO_RECORD_WRITES_MAX,
  DemoRecordIssueSchema,
  DemoRecordedWriteSchema,
  type DemoRecordedWrite,
  type DemoSampleRecords,
} from '@indx-workspace/contracts/demo-operator';
import {
  PUBLIC_SOURCE_RECORDS_RESOURCE,
  PUBLIC_SOURCE_SNAPSHOT_SCRIPT,
  PublicSourceSnapshotSchema,
  type PublicSourceSnapshot,
} from '@indx-workspace/sdk/define';
import { z } from 'zod';

import { ARGUMENT_PIECE_CHARACTERS, RECORDS_JSON_MAX_BYTES, RECORDS_PER_ANSWER } from './limits';
import { initializeHandlerSource, STAND_IN_FRAMING } from './fake-send-server';

/**
 * The constants of cyrb53, the 53-bit string hash a kept call's key is (see {@link callKey}); the
 * stand-in's source and the platform read them from here, so the two cannot drift apart.
 */
const CYRB53 = Object.freeze({
  seed1: 0xdeadbeef,
  seed2: 0x41c6ce57,
  mix1: 0x9e3779b1,
  mix2: 0x5f356495,
  final1: 0x85ebca6b,
  final2: 0xc2b2ae35,
  highWord: 0x100000000,
  highMask: 0x1fffff,
});

const SERVER_SOURCE = `
const { reads, writes, recorded = [], written = [], schemas = {}, snapshots = {} } = JSON.parse(process.argv.slice(1).join(''));
${PUBLIC_SOURCE_SNAPSHOT_SCRIPT}
const snapshot = (name, args) => {
  const result = answerPublicSourceSnapshot(snapshots[name], args);
  if (result.error) return { isError: true, content: [{ type: 'text', text: PUBLIC_SOURCE_QUERY_INVALID }] };
  return { content: [{ type: 'text', text: JSON.stringify(result.answer) }], structuredContent: result.answer };
};
const answer = ${JSON.stringify(DEMO_SEND_RESULT.en)};
const limit = ${String(RECORDS_PER_ANSWER)};
const SEARCH_KEYS = ['query', 'q', 'search', 'text'];
const canonical = (value) => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
};
const C = ${JSON.stringify(CYRB53)};
const callKey = (value) => {
  const text = canonical(value ?? {});
  let h1 = C.seed1;
  let h2 = C.seed2;
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    h1 = Math.imul(h1 ^ unit, C.mix1);
    h2 = Math.imul(h2 ^ unit, C.mix2);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), C.final1) ^ Math.imul(h2 ^ (h2 >>> 13), C.final2);
  h2 = Math.imul(h2 ^ (h2 >>> 16), C.final1) ^ Math.imul(h1 ^ (h1 >>> 13), C.final2);
  return (C.highWord * (C.highMask & h2) + (h1 >>> 0)).toString(16);
};
const recordedBy = Object.fromEntries(recorded.map((entry) => [entry.write, entry]));
const kept = {};
for (const call of [...written].reverse()) {
  if (call.outcome.recorded !== true) continue;
  const read = recordedBy[call.write].read;
  kept[read] = [...(kept[read] ?? []), call.outcome.record];
}
const matches = (record, args) =>
  Object.entries(args ?? {}).every(([key, value]) => {
    if (typeof value !== 'string' || value === '') return true;
    const wanted = value.toLowerCase();
    if (SEARCH_KEYS.includes(key)) return JSON.stringify(record).toLowerCase().includes(wanted);
    if (!Object.hasOwn(record, key)) return true;
    return String(record[key]).toLowerCase() === wanted;
  });
const read = (name, args) => {
  const cut = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, limit) : limit;
  const all = [...(kept[name] ?? []), ...reads[name]];
  const records = all.filter((record) => matches(record, args)).slice(0, cut);
  return { content: [{ type: 'text', text: JSON.stringify(records) }], structuredContent: { records } };
};
const reply = (structured, isError) => ({
  content: [{ type: 'text', text: JSON.stringify(structured) }],
  structuredContent: structured,
  ...(isError ? { isError: true } : {}),
});
const write = (name, args) => {
  const key = callKey(args);
  const call = written.find((candidate) => candidate.write === name && candidate.key === key);
  const base = { demoOnly: true, tool: name };
  if (call === undefined) return reply({ ...base, recorded: false, code: 'demo_write_not_recorded' }, true);
  if (call.outcome.recorded === true) return reply({ ...base, recorded: true, record: call.outcome.record }, false);
  return reply({ ...base, recorded: false, code: call.outcome.code, issues: call.outcome.issues }, true);
};
const tool = (name, description, inputSchema) => ({ name, description, inputSchema });
const ANY = { type: 'object', additionalProperties: true };
const handlers = {
  ${initializeHandlerSource('demo-records')}
  'tools/list': () => ({
    tools: [
      ...Object.keys(reads).map((name) => tool(name, 'Demo only: sample records, nothing real.', ANY)),
      ...Object.keys(snapshots).map((name) => tool(name, 'Demo only: a dated snapshot of a public source.', ANY)),
      ...writes.map((name) =>
        Object.hasOwn(recordedBy, name)
          ? tool(name, 'Demo only: once a person approves it, the change is kept in this demo and nowhere else.', schemas[recordedBy[name].kind])
          : tool(name, 'Demo only: this does nothing and sends nothing.', ANY),
      ),
    ],
  }),
  'tools/call': (params) => {
    const name = params?.name ?? null;
    if (typeof name === 'string' && Object.hasOwn(snapshots, name)) return snapshot(name, params?.arguments);
    if (typeof name === 'string' && Object.hasOwn(reads, name)) return read(name, params?.arguments);
    if (typeof name === 'string' && Object.hasOwn(recordedBy, name)) return write(name, params?.arguments);
    return {
      content: [{ type: 'text', text: answer }],
      structuredContent: { demoOnly: true, delivered: false, tool: name, arguments: params?.arguments ?? null },
    };
  },
};
${STAND_IN_FRAMING}`;

/** One record a stand-in answers with: a sample record tagged with its language, or a kept one. */
const StandInRecordSchema = z.record(z.string(), z.unknown());
type StandInRecord = z.infer<typeof StandInRecordSchema>;

/** What the platform kept for one approved call of a recorded write (ADR-0169 D3). */
const KeptOutcomeSchema = z.discriminatedUnion('recorded', [
  z.strictObject({ recorded: z.literal(true), record: StandInRecordSchema }).readonly(),
  z
    .strictObject({
      recorded: z.literal(false),
      code: z.literal('demo_record_invalid'),
      issues: z.array(DemoRecordIssueSchema).max(DEMO_RECORD_ISSUES_MAX).readonly(),
    })
    .readonly(),
]);
export type KeptOutcome = z.infer<typeof KeptOutcomeSchema>;

/**
 * One approved call of a recorded write: the write tool, the {@link callKey} of its arguments, and
 * what was kept. The arguments themselves are not kept, so a refused call costs a few bytes.
 */
const KeptCallSchema = z
  .strictObject({
    write: z.string().min(1),
    key: z.string().regex(/^[0-9a-f]{1,14}$/u),
    outcome: KeptOutcomeSchema,
  })
  .readonly();

/** Canonical JSON of a parsed JSON value: object members sorted, no whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const members = Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`);
  return `{${members.join(',')}}`;
}

/**
 * The key a kept call is found by: a 53-bit hash (cyrb53) of the canonical JSON of its arguments,
 * in hexadecimal. The stand-in's source computes the same function on the arguments it is called
 * with; the tests that keep a call here and find it there prove the two agree.
 */
export function callKey(value: unknown): string {
  const text = canonical(value ?? {});
  let h1: number = CYRB53.seed1;
  let h2: number = CYRB53.seed2;
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    h1 = Math.imul(h1 ^ unit, CYRB53.mix1);
    h2 = Math.imul(h2 ^ unit, CYRB53.mix2);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), CYRB53.final1) ^ Math.imul(h2 ^ (h2 >>> 13), CYRB53.final2);
  h2 = Math.imul(h2 ^ (h2 >>> 16), CYRB53.final1) ^ Math.imul(h1 ^ (h1 >>> 13), CYRB53.final2);
  return (CYRB53.highWord * (CYRB53.highMask & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Everything a records stand-in answers from, as its arguments carry it: the records of each read
 * tool, the write tools, the recorded writes, and the approved calls kept so far. Parsed again
 * whenever the platform reads a stand-in's row back, since the row is persisted JSON.
 */
const STATE_SHAPE = {
  reads: z.record(z.string(), z.array(StandInRecordSchema).readonly()),
  writes: z.array(z.string()).readonly(),
  recorded: z.array(DemoRecordedWriteSchema).readonly(),
  written: z.array(KeptCallSchema).max(DEMO_RECORD_WRITES_MAX).readonly(),
  /** The public-source reads (ADR-0170 D4), each with its one snapshot; none on most stand-ins. */
  snapshots: z.record(z.string(), PublicSourceSnapshotSchema).optional(),
};
export type RecordsServerState = Readonly<z.infer<z.ZodObject<typeof STATE_SHAPE>>>;

/** The state as the arguments carry it: with the record kinds' input schemas, which are not state. */
const CarriedStateSchema = z
  .strictObject({
    reads: STATE_SHAPE.reads,
    writes: STATE_SHAPE.writes,
    // A stand-in with no recorded write carries neither list (D5 of ADR-0169: its arguments are
    // the ones it had before recorded writes existed).
    recorded: STATE_SHAPE.recorded.optional(),
    written: STATE_SHAPE.written.optional(),
    schemas: z.unknown().optional(),
    snapshots: STATE_SHAPE.snapshots,
  })
  .transform(({ reads, writes, recorded, written, snapshots }): RecordsServerState => ({
    reads,
    writes,
    recorded: recorded ?? [],
    written: written ?? [],
    ...(snapshots === undefined ? {} : { snapshots }),
  }));

/**
 * The JSON Schema of each record kind, as a recorded write's `inputSchema`, without the `$schema`
 * dialect line. It rides in the arguments, not in the source, so the source stays free of any
 * address.
 */
const RECORD_INPUT_SCHEMAS = Object.fromEntries(
  Object.entries(DEMO_RECORD_SCHEMAS).map(([kind, schema]) => [
    kind,
    Object.fromEntries(
      Object.entries(z.toJSONSchema(schema, { io: 'input' })).filter(([key]) => key !== '$schema'),
    ),
  ]),
);

/** The records of a set as a list: an array's items, or an object's values, each as an object. */
function recordsOf(data: unknown): readonly StandInRecord[] {
  const items: readonly unknown[] = Array.isArray(data)
    ? data
    : data !== null && typeof data === 'object'
      ? Object.values(data)
      : [];
  return items.map((item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? (item as StandInRecord)
      : { value: item },
  );
}

/** Whether a UTF-16 code unit is the high (first) half of a surrogate pair. */
function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

/**
 * The one snapshot a public-source read answers from. A read has one snapshot, valid by the seed's
 * own check made again where the stand-in is built. The seed files it once per language (the
 * snapshot's items carry their own text), so the sets are at most one per language and all hold
 * that same snapshot; two sets of one language, or two different snapshots, are refused.
 */
function publicSourceSnapshotOf(
  tool: string,
  sets: readonly Pick<DemoSampleRecords, 'lang' | 'data'>[],
): PublicSourceSnapshot {
  const parsed = sets.map((set) => PublicSourceSnapshotSchema.safeParse(set.data));
  const [first] = parsed;
  const perLanguage = new Set(sets.map((set) => set.lang)).size === sets.length;
  const same = parsed.every(
    (each) => each.success && JSON.stringify(each.data) === JSON.stringify(first?.data),
  );
  if (first?.success !== true || !perLanguage || !same) {
    throw new Error(`the demo's public-source snapshot for ${tool} must be one valid snapshot`);
  }
  return first.data;
}

/** Thrown by {@link recordsServerCommand} when the records are too many for one stand-in. */
export class RecordsTooLargeError extends Error {}

/**
 * A new stand-in's state: `reads` answer from the records of the `sets` that name them, a read
 * some `recorded` write answers with is offered even with no set, and nothing is kept yet.
 */
export function recordsServerState(input: {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly sets: readonly (Pick<DemoSampleRecords, 'lang' | 'tools' | 'data'> & {
    readonly resource?: string;
  })[];
  readonly recorded?: readonly DemoRecordedWrite[];
}): RecordsServerState {
  const recorded = input.recorded ?? [];
  const reads: Record<string, StandInRecord[]> = {};
  const snapshots: Record<string, PublicSourceSnapshot> = {};
  for (const tool of [...input.reads, ...recorded.map((entry) => entry.read)]) {
    const snapshotSets = input.sets.filter(
      (set) => set.tools.includes(tool) && set.resource === PUBLIC_SOURCE_RECORDS_RESOURCE,
    );
    if (snapshotSets.length > 0) {
      snapshots[tool] = publicSourceSnapshotOf(tool, snapshotSets);
      continue;
    }
    reads[tool] = input.sets
      .filter((set) => set.tools.includes(tool))
      .flatMap((set) => recordsOf(set.data).map((record) => ({ ...record, lang: set.lang })));
  }
  return {
    reads,
    writes: input.writes,
    recorded,
    written: [],
    ...(Object.keys(snapshots).length === 0 ? {} : { snapshots }),
  };
}

/** The command and arguments of a stdio connector that runs the stand-in from `state`. */
export function recordsServerArgs(state: RecordsServerState): {
  readonly command: string;
  readonly args: readonly string[];
} {
  // A stand-in with no recorded write (and so nothing kept) carries exactly what it did before.
  const json = JSON.stringify(
    state.recorded.length === 0
      ? {
          reads: state.reads,
          writes: state.writes,
          // Public-source snapshots ride along only when a read has one (ADR-0170 D4).
          ...(state.snapshots === undefined ? {} : { snapshots: state.snapshots }),
        }
      : { ...state, schemas: RECORD_INPUT_SCHEMAS },
  );
  if (Buffer.byteLength(json, 'utf8') > RECORDS_JSON_MAX_BYTES) {
    throw new RecordsTooLargeError(
      `the sample records of one connector are over ${String(RECORDS_JSON_MAX_BYTES)} bytes`,
    );
  }
  const pieces: string[] = [];
  for (let at = 0; at < json.length;) {
    let end = Math.min(at + ARGUMENT_PIECE_CHARACTERS, json.length);
    // A piece never ends between the two halves of a surrogate pair: each half alone would reach the process as U+FFFD.
    if (end < json.length && isHighSurrogate(json.charCodeAt(end - 1))) end -= 1;
    pieces.push(json.slice(at, end));
    at = end;
  }
  return { command: 'node', args: ['-e', SERVER_SOURCE, ...pieces] };
}

/**
 * The command and arguments of a stdio connector that runs a new stand-in: `reads` answer from the
 * records of the `sets` that name them, `recorded` writes keep what a person approves (ADR-0169),
 * the other `writes` answer `DEMO_SEND_RESULT`.
 */
export function recordsServerCommand(
  input: Parameters<typeof recordsServerState>[0],
): ReturnType<typeof recordsServerArgs> {
  return recordsServerArgs(recordsServerState(input));
}

/**
 * The state of the stand-in a connector row runs, or `null` for a row that is not a records
 * stand-in. A records stand-in whose carried state does not parse is refused with an error: its
 * arguments are the platform's own, so that is a defect, never a visitor's input.
 */
export function readRecordsServerState(connector: {
  readonly command?: string | null;
  readonly args?: readonly string[] | null;
}): RecordsServerState | null {
  const args = connector.args ?? [];
  if (connector.command !== 'node' || args[0] !== '-e' || args[1] !== SERVER_SOURCE) return null;
  return CarriedStateSchema.parse(JSON.parse(args.slice(2).join('')));
}

/** The kept calls a carried state holds, whatever else it holds. */
const KeptWritesSchema = z.object({ written: STATE_SHAPE.written.optional() });

/**
 * The approved calls a records stand-in row keeps, read from its carried state even when the row
 * runs an earlier release's source ({@link readRecordsServerState} reads only the current one), so
 * a deploy that changes the stand-in's code does not drop a visitor's kept writes (ADR-0169). A row
 * that is no records stand-in, or whose state holds no kept calls in this shape, keeps none.
 */
export function readKeptWrites(connector: {
  readonly command?: string | null;
  readonly args?: readonly string[] | null;
}): RecordsServerState['written'] {
  const args = connector.args ?? [];
  const carried = args.slice(2).join('');
  if (connector.command !== 'node' || args[0] !== '-e' || !carried.startsWith('{')) return [];
  const parsed = KeptWritesSchema.safeParse(JSON.parse(carried));
  return parsed.success ? (parsed.data.written ?? []) : [];
}
