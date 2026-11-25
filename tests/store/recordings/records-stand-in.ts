/**
 * The records stand-ins a use-cases entry's recording calls (ADR-0169): each connector the entry's
 * demo copy replaces with a stand-in that keeps an approved write (`CONNECTOR_TOOLS` in the seed,
 * with its `recorded` writes), answering as the provisioned one does
 * (`apps/web/server/demo/provision/records-server.ts`):
 *
 * - a recorded write keeps its arguments as a record of its kind (`DEMO_RECORD_SCHEMAS`), with an
 *   `id` counted per kind, and answers `{ demoOnly, tool, recorded: true, record }`; arguments that
 *   are not such a record are refused with `demo_record_invalid` and the issues' paths;
 * - an approved call is kept once: the same call again (tool and canonical arguments, as the
 *   platform keys what it kept) answers what was kept for it and keeps nothing more;
 * - a write nobody approved is refused with `demo_write_not_recorded` and keeps nothing: in the
 *   demo the platform keeps a call only once a person approves it, so a gate that did not hold
 *   fails the recording instead of showing a kept record;
 * - the read a recorded write names answers the kept records, newest first, narrowed by its
 *   arguments as the provisioned stand-in narrows them, at most `limit` and never more than
 *   {@link RECORDS_PER_ANSWER}.
 *
 * The state lives for one recording: `recordsStandIns` makes fresh stand-ins each time. The
 * provisioned stand-in's read also answers the entry's seeded record sets; these stand-ins do not,
 * so an entry whose recorded connector has seeded record sets is refused until this harness
 * answers them too, rather than recorded with reads that leave them out.
 */
import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  DEMO_RECORD_SCHEMAS,
  type DemoRecordedWrite,
  type DemoSampleRecords,
} from '@indx-workspace/contracts/demo-operator';
import { connectorServerKey } from '@indx-workspace/contracts/tool-connectors';
import type { z } from 'zod';

import { RECORDS_PER_ANSWER } from '../../../apps/web/server/demo/provision/limits.ts';
import type { McpToolResult } from '../../gallery/harness/mcp-client.ts';
import type { ScriptedConnector } from '../../gallery/harness/scripted-workspace-types.ts';
import { hasSource } from '../../../examples/store/catalog/define.ts';
import { CATALOG } from '../../../examples/store/catalog/index.ts';
import { buildSeed, CONNECTOR_TOOLS } from '../seed/build.ts';

/** The string arguments a read matches against a record's whole text, as the stand-in does. */
const SEARCH_KEYS: ReadonlySet<string> = new Set(['query', 'q', 'search', 'text']);

type StandInRecord = Readonly<Record<string, unknown>>;

/** Whether `record` is kept by a read with `args`, as the provisioned stand-in narrows. */
function matches(record: StandInRecord, args: Record<string, unknown>): boolean {
  return Object.entries(args).every(([key, value]) => {
    if (typeof value !== 'string' || value === '') return true;
    const wanted = value.toLowerCase();
    if (SEARCH_KEYS.has(key)) return JSON.stringify(record).toLowerCase().includes(wanted);
    if (!Object.hasOwn(record, key)) return true;
    return String(record[key]).toLowerCase() === wanted;
  });
}

const reply = (structured: Record<string, unknown>, isError: boolean): McpToolResult => ({
  text: JSON.stringify(structured),
  isError,
});

/** A kept record, with the read that answers with it. */
interface Kept {
  readonly read: string;
  readonly record: StandInRecord;
}

/** At most `limit` records, never more than {@link RECORDS_PER_ANSWER}. */
function cutOf(limit: unknown): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
    ? Math.min(limit, RECORDS_PER_ANSWER)
    : RECORDS_PER_ANSWER;
}

/** The issues of a refused record: each field's path (`$` for the root) and why. */
function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? '$' : issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/** One stand-in for connector `name` (its id `id`) that keeps the writes `recorded` names. */
function standIn(
  name: string,
  id: string,
  recorded: readonly DemoRecordedWrite[],
): ScriptedConnector {
  const kept: Kept[] = [];
  /** What was kept for each approved call, by its canonical text. */
  const outcomes = new Map<string, McpToolResult>();
  const key = connectorServerKey(name, id, new Set());
  const keep = (
    entry: DemoRecordedWrite,
    args: Record<string, unknown>,
    base: { readonly demoOnly: true; readonly tool: string },
  ): McpToolResult => {
    const parsed = DEMO_RECORD_SCHEMAS[entry.kind].safeParse(args);
    if (!parsed.success) {
      return reply(
        { ...base, recorded: false, code: 'demo_record_invalid', issues: issuesOf(parsed.error) },
        true,
      );
    }
    // Ids count per kind, so a stand-in with two recorded writes numbers each kind from 1.
    const sameKind = kept.filter(({ record }) => record['kind'] === entry.kind).length;
    const record = {
      id: `${entry.kind}-${String(sameKind + 1)}`,
      kind: entry.kind,
      ...parsed.data,
    };
    kept.unshift({ read: entry.read, record });
    return reply({ ...base, recorded: true, record }, false);
  };
  const write = (
    entry: DemoRecordedWrite,
    args: Record<string, unknown>,
    approved: readonly string[],
  ) => {
    const base = { demoOnly: true, tool: entry.write } as const;
    const call = canonicalCall(`mcp__${key}__${entry.write}`, args);
    if (!approved.includes(call)) {
      return reply({ ...base, recorded: false, code: 'demo_write_not_recorded' }, true);
    }
    const before = outcomes.get(call);
    if (before !== undefined) return before;
    const outcome = keep(entry, args, base);
    outcomes.set(call, outcome);
    return outcome;
  };
  return {
    id,
    session: {
      call: (tool, args, options) => {
        const writing = recorded.find((entry) => entry.write === tool);
        if (writing !== undefined) {
          return Promise.resolve(write(writing, args, options?.approvedToolCalls ?? []));
        }
        if (!recorded.some((entry) => entry.read === tool)) {
          return Promise.resolve({ text: `${name} has no tool ${tool}`, isError: true });
        }
        const records = kept
          .filter((one) => one.read === tool && matches(one.record, args))
          .map((one) => one.record)
          .slice(0, cutOf(args['limit']));
        return Promise.resolve({ text: JSON.stringify(records), isError: false });
      },
    },
  };
}

/** The id a recording gives the stand-in of an entry's `index`-th connector. */
const standInId = (index: number): string =>
  `6b1c1f0e-0000-4000-8000-0000000000${(0xc0 + index).toString(16)}`;

/** The record sets the seed of `slug` carries; none for an entry without a source. */
function seededSets(slug: string): readonly DemoSampleRecords[] {
  const entry = CATALOG.filter(hasSource).find((one) => one.slug === slug);
  return entry === undefined ? [] : buildSeed(entry).records;
}

/**
 * Fresh records stand-ins for every connector of `slug` that keeps a write, by connector name;
 * none for an entry whose connectors keep nothing. Throws for a recorded connector with seeded
 * record sets (`sets`, the seed's by default), whose reads these stand-ins do not answer.
 */
export function recordsStandIns(
  slug: string,
  sets: readonly DemoSampleRecords[] = seededSets(slug),
): Readonly<Record<string, ScriptedConnector>> {
  return Object.fromEntries(
    Object.entries(CONNECTOR_TOOLS[slug] ?? {}).flatMap(([name, tools], index) => {
      const recorded = tools.recorded ?? [];
      if (recorded.length === 0) return [];
      const seeded = sets.filter((set) => set.connector === name);
      if (seeded.length > 0) {
        throw new Error(
          `${slug}: ${name} has ${String(seeded.length)} seeded record sets, which the recording's records stand-in does not answer yet`,
        );
      }
      return [[name, standIn(name, standInId(index), recorded)] as const];
    }),
  );
}
