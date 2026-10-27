import { BUILDER_CATALOG_KINDS } from '@indx-workspace/contracts/builder';
import { describe, expect, it } from 'vitest';

import type { Role } from '../../../rbac/roles';
import type { CallContext, CatalogEntry, CatalogKind, CatalogPort } from '../../ports';

export interface CatalogFixture {
  readonly port: CatalogPort;
  /** What the seeded workspace holds for an Owner, in catalog order. */
  readonly entries: readonly CatalogEntry[];
  /** A context for a person with `role`, or for a run with no person behind it. */
  readonly ctxOf: (role: Role | null) => CallContext;
}

const NAMES = {
  models: ['Primary'],
  skills: ['triage'],
  connectors: ['crm', 'files'],
  runtimeProfiles: ['Standard'],
} satisfies Partial<Record<CatalogKind, string[]>>;

const kindsOf = (entries: readonly CatalogEntry[]): CatalogKind[] => [
  ...new Set(entries.map((entry) => entry.kind)),
];

/** Memory and production answer the same shapes for the same fixture. */
export function describeCatalogConformance(
  label: string,
  make: () => Promise<CatalogFixture>,
): void {
  describe(`CatalogPort: ${label}`, () => {
    it('lists the seeded names, each as exactly {id, kind, name}, in catalog order', async () => {
      const { port, ctxOf } = await make();
      const entries = await port.list(ctxOf('owner'), BUILDER_CATALOG_KINDS);

      for (const [kind, names] of Object.entries(NAMES)) {
        const listed = entries.filter((entry) => entry.kind === kind).map((entry) => entry.name);
        expect(listed.sort()).toEqual([...names].sort());
      }
      const order = (kind: CatalogKind): number => BUILDER_CATALOG_KINDS.indexOf(kind);
      expect(kindsOf(entries)).toEqual([...kindsOf(entries)].sort((a, b) => order(a) - order(b)));
      for (const entry of entries)
        expect(Object.keys(entry).sort()).toEqual(['id', 'kind', 'name']);
    });

    it('lists only the kinds asked for', async () => {
      const { port, ctxOf } = await make();
      const entries = await port.list(ctxOf('owner'), ['connectors']);
      expect(kindsOf(entries)).toEqual(['connectors']);
      expect(entries).toHaveLength(NAMES.connectors.length);
    });

    it('leaves out a kind the role cannot read, as the console does', async () => {
      const { port, ctxOf } = await make();
      expect(kindsOf(await port.list(ctxOf('admin'), BUILDER_CATALOG_KINDS))).toContain('models');
      for (const role of ['builder', 'viewer'] as const) {
        expect(kindsOf(await port.list(ctxOf(role), BUILDER_CATALOG_KINDS))).not.toContain(
          'models',
        );
      }
    });

    it('lists nothing for a run with no person behind it', async () => {
      const { port, ctxOf } = await make();
      expect(await port.list(ctxOf(null), BUILDER_CATALOG_KINDS)).toEqual([]);
    });
  });
}
