/**
 * Which tools of the live demo agents could send or write outside, and what the visitor's copy
 * does with each (the provisioner: `apps/web/server/demo/provision/outside-tools.ts`). A tool that
 * only reads is left out of the copy; a tool that could send or write is replaced by a stand-in
 * that answers `DEMO_SEND_RESULT` and does nothing. The table below is the reviewed inventory of
 * the 14 live entries: a new tool in any source fails this test until someone has decided which
 * of the two it is.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATALOG } from '../../examples/store/catalog/index.ts';
import { REPOSITORY_ROOT } from '../apps/registry.ts';
import { demoAgentDefinition } from './demo-agents.test-support.ts';

interface Inventory {
  /** Tools replaced by a stand-in: they could send or write, or their effect is not known. */
  readonly standIn: readonly string[];
  /** Tools that only read: not carried into the copy. */
  readonly omitted: readonly string[];
}

const NONE: Inventory = { standIn: [], omitted: [] };

/** The reviewed inventory, by catalog slug. */
const EXPECTED: Readonly<Record<string, Inventory>> = {
  maintenance: { standIn: ['maintenance'], omitted: [] },
  'quality-defect': { standIn: ['qms'], omitted: [] },
  quotation: { standIn: ['erp'], omitted: [] },
  'contract-review': NONE,
  'customer-inquiry': { standIn: [], omitted: ['crm'] },
  'meeting-minutes': { standIn: ['task-tracker', 'tracker'], omitted: [] },
  'manual-search': NONE,
  'excel-consolidation': NONE,
  'cad-drafting': NONE,
  'ringi-review': { standIn: ['authority', 'workflow'], omitted: [] },
  'crm-sales': { standIn: ['crm', 'email'], omitted: [] },
  'team-chat': { standIn: ['team-chat'], omitted: [] },
  wiki: { standIn: ['wiki'], omitted: [] },
  'service-desk': { standIn: ['service-desk'], omitted: [] },
};

interface DefinedTools {
  readonly tools?: readonly (
    | { readonly connector: string }
    | { readonly name: string; readonly spec: string; readonly allow?: readonly string[] }
  )[];
}

const READING_METHODS = new Set(['get', 'head']);

/** The method of each operation id an OpenAPI document declares. */
function methodsByOperationId(specFile: string): Map<string, string> {
  const document = JSON.parse(readFileSync(specFile, 'utf8')) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  const methods = new Map<string, string>();
  for (const operations of Object.values(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (operation.operationId !== undefined) methods.set(operation.operationId, method);
    }
  }
  return methods;
}

/** Whether every operation an `allow` list admits only reads. */
function onlyReads(allow: readonly string[] | undefined, specFile: string): boolean {
  if (allow === undefined) return false;
  const methods = methodsByOperationId(specFile);
  return allow.every((rule) => {
    const operationId = /^operationId:(.+)$/u.exec(rule)?.[1];
    const method =
      operationId === undefined ? rule.split(' ')[0]?.toLowerCase() : methods.get(operationId);
    return method !== undefined && READING_METHODS.has(method);
  });
}

describe('the tools of the live demo agents', () => {
  const live = CATALOG.filter((entry) => entry.status === 'live');

  it('has a reviewed inventory for exactly the live entries', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(live.map((entry) => entry.slug).sort());
  });

  it.each(live.map((entry) => [entry.slug, entry] as const))(
    '%s: reads are left out and every other tool is a stand-in',
    (slug, entry) => {
      const source = path.join(REPOSITORY_ROOT, entry.source);
      const defined = demoAgentDefinition(entry) as DefinedTools;
      const standIn: string[] = [];
      const omitted: string[] = [];
      for (const tool of defined.tools ?? []) {
        if ('connector' in tool) {
          // A connector's tools are not known from outside: a stand-in.
          standIn.push(tool.connector);
        } else if (onlyReads(tool.allow, path.join(source, tool.spec))) {
          omitted.push(tool.name);
        } else {
          standIn.push(tool.name);
        }
      }
      expect({ standIn: standIn.sort(), omitted: omitted.sort() }).toEqual(EXPECTED[slug]);
    },
  );
});
