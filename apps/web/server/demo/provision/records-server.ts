/**
 * The stand-in a demo agent's connector is replaced by when the entry has sample records (internal
 * spec, "How Try it works"). Like `fake-send-server.ts` it is an MCP server on standard input and
 * output with no network, file or process code at all, one plain string. It answers:
 *
 * - each read tool the seed names with that tool's record sets: the records of every set, in both
 *   languages, each tagged with its language (`lang`), narrowed by the call's arguments;
 * - each write tool with `DEMO_SEND_RESULT`, doing nothing, as `fake-send-server.ts` does.
 *
 * The records travel in the connector's arguments (the copy has no file for the stand-in to read),
 * as JSON split into pieces small enough for one argument. Narrowing: a string argument named
 * `query`, `q`, `search` or `text` keeps the records whose text holds it (case ignored); any other
 * string argument keeps the records whose field of that name equals it (case ignored), and is
 * ignored by a record with no such field; a `limit` argument cuts the answer. A call never gets more
 * than {@link RECORDS_PER_ANSWER} records.
 */
import { DEMO_SEND_RESULT } from '@indx-workspace/contracts/demo';
import type { DemoSampleRecords } from '@indx-workspace/contracts/demo-operator';

import { ARGUMENT_PIECE_CHARACTERS, RECORDS_JSON_MAX_BYTES, RECORDS_PER_ANSWER } from './limits';
import { initializeHandlerSource, STAND_IN_FRAMING } from './fake-send-server';

const SERVER_SOURCE = `
const { reads, writes } = JSON.parse(process.argv.slice(1).join(''));
const answer = ${JSON.stringify(DEMO_SEND_RESULT.en)};
const limit = ${String(RECORDS_PER_ANSWER)};
const SEARCH_KEYS = ['query', 'q', 'search', 'text'];
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
  const records = reads[name].filter((record) => matches(record, args)).slice(0, cut);
  return { content: [{ type: 'text', text: JSON.stringify(records) }], structuredContent: { records } };
};
const tool = (name, description) => ({
  name,
  description,
  inputSchema: { type: 'object', additionalProperties: true },
});
const handlers = {
  ${initializeHandlerSource('demo-records')}
  'tools/list': () => ({
    tools: [
      ...Object.keys(reads).map((name) => tool(name, 'Demo only: sample records, nothing real.')),
      ...writes.map((name) => tool(name, 'Demo only: this does nothing and sends nothing.')),
    ],
  }),
  'tools/call': (params) => {
    const name = params?.name ?? null;
    if (typeof name === 'string' && Object.hasOwn(reads, name)) return read(name, params?.arguments);
    return {
      content: [{ type: 'text', text: answer }],
      structuredContent: { demoOnly: true, delivered: false, tool: name, arguments: params?.arguments ?? null },
    };
  },
};
${STAND_IN_FRAMING}`;

/** The records of a set as a list: an array's items, or an object's values, each as an object. */
function recordsOf(data: unknown): readonly Record<string, unknown>[] {
  const items: readonly unknown[] = Array.isArray(data)
    ? data
    : data !== null && typeof data === 'object'
      ? Object.values(data)
      : [];
  return items.map((item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : { value: item },
  );
}

/** Whether a UTF-16 code unit is the high (first) half of a surrogate pair. */
function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

/** Thrown by {@link recordsServerCommand} when the records are too many for one stand-in. */
export class RecordsTooLargeError extends Error {}

/**
 * The command and arguments of a stdio connector that runs the stand-in: `reads` answer from the
 * records of the `sets` that name them, `writes` answer `DEMO_SEND_RESULT`.
 */
export function recordsServerCommand(input: {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly sets: readonly Pick<DemoSampleRecords, 'lang' | 'tools' | 'data'>[];
}): { readonly command: string; readonly args: readonly string[] } {
  const reads: Record<string, Record<string, unknown>[]> = {};
  for (const tool of input.reads) {
    reads[tool] = input.sets
      .filter((set) => set.tools.includes(tool))
      .flatMap((set) => recordsOf(set.data).map((record) => ({ ...record, lang: set.lang })));
  }
  const json = JSON.stringify({ reads, writes: input.writes });
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
