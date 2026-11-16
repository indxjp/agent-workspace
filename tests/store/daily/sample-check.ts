/**
 * The nightly sample check (spec, "The GCP deployment"): the platform's own report of each demo
 * template (`GET /api/demo/templates`) against what the catalog says a visitor's copy gets: the
 * agent's name, the number of sample files (`demo.seed`) and the number of sample record sets
 * (`demo.records`, one set per resource per language that a read tool answers for). Any difference is listed, and the command
 * exits non-zero. It spends nothing.
 */
import {
  DemoTemplateReportsSchema,
  type DemoTemplateReport,
} from '@indx-workspace/contracts/demo-operator';

import type { LiveEntry } from '../../../examples/store/catalog/define.ts';
import { buildSeed } from '../seed/build.ts';
import { operatorCall, type Platform } from './platform.ts';

/** What the catalog says an entry's template holds. */
export interface ExpectedTemplate {
  readonly entry: string;
  readonly agent: string;
  readonly files: number;
  readonly recordSets: number;
}

/**
 * What `entry`'s template should hold: what the deploy's seeding step sends for it
 * (`../seed/build.ts`), so the check and the seed count the same files and record sets (a records
 * file no read tool answers for is not sent, and not expected).
 */
export function expectedTemplate(entry: LiveEntry): ExpectedTemplate {
  const seed = buildSeed(entry);
  return {
    entry: entry.slug,
    agent: entry.demo.agent,
    files: seed.files.length,
    recordSets: seed.records.length,
  };
}

/** Every way `reports` differs from `expected`, one sentence each; empty when they agree. */
export function templateDifferences(
  expected: readonly ExpectedTemplate[],
  reports: readonly DemoTemplateReport[],
): readonly string[] {
  const differences: string[] = [];
  for (const want of expected) {
    const got = reports.find((report) => report.entry === want.entry);
    if (got === undefined) differences.push(`${want.entry}: no template was reported`);
    else if (got.agent === null) differences.push(`${want.entry}: the template has no agent`);
    else {
      if (got.agent !== want.agent) differences.push(`${want.entry}: the agent has another name`);
      if (got.files !== want.files) {
        differences.push(
          `${want.entry}: ${String(got.files)} sample files, expected ${String(want.files)}`,
        );
      }
      if (got.recordSets !== want.recordSets) {
        differences.push(
          `${want.entry}: ${String(got.recordSets)} record sets, expected ${String(want.recordSets)}`,
        );
      }
    }
  }
  for (const got of reports) {
    if (!expected.some((want) => want.entry === got.entry)) {
      differences.push(`${got.entry}: a template the catalog does not list`);
    }
  }
  return differences;
}

/** The differences between the platform's report and the catalog; throws when the report is unreadable. */
export async function sampleCheck(
  platform: Platform,
  expected: readonly ExpectedTemplate[],
): Promise<readonly string[]> {
  const response = await operatorCall(platform, 'GET', '/api/demo/templates');
  const parsed = DemoTemplateReportsSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('GET /api/demo/templates: the report is not readable');
  return templateDifferences(expected, parsed.data.templates);
}
