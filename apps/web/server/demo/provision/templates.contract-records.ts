/** The sample records of a declared connector. */
import type { DemoSampleRecords } from '@indx-workspace/contracts/demo-operator';
import { describe, expect, it } from 'vitest';

import { SPEC, copy, type MakeDemoTemplatesWorld } from './templates.contract-world';

export function describeDeclaredConnectorRecords(make: MakeDemoTemplatesWorld): void {
  describe('the records of a declared connector', () => {
    const RECORDS: readonly DemoSampleRecords[] = [
      {
        connector: 'crm',
        resource: 'contact',
        lang: 'en',
        tools: ['contact_list', 'contact_get'],
        data: [{ id: 'c1', name: 'Misaki Sato' }],
      },
      {
        connector: 'crm',
        resource: 'contact',
        lang: 'ja',
        tools: ['contact_list', 'contact_get'],
        data: [{ id: 'c1', name: '佐藤 美咲' }],
      },
    ];
    const CRM = {
      kind: 'declared',
      name: 'crm',
      reads: ['contact_list', 'contact_get'],
      writes: ['contact_update'],
    } as const;

    it('becomes a records stand-in: its read tools answer from the records, its write tool is demo-only', async () => {
      const world = await make();
      const entry = world.entry('records');
      await world.seedTemplate(entry, { ...SPEC, connectors: [CRM], records: RECORDS });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const [crm, ...rest] = await world.connectors(guest.workspaceId);
      expect(rest).toEqual([]);
      if (crm === undefined || crm.transport !== 'stdio') throw new Error('no records stand-in');
      expect(crm).toMatchObject({
        name: 'crm',
        command: 'node',
        url: null,
        hasCredential: false,
      });
      const source = crm.args?.[1] ?? '';
      expect(source).toContain('demo-records');
      // The records ride in the arguments after the source: both languages.
      const carried = (crm.args ?? []).slice(2).join('');
      expect(carried).toContain('Misaki Sato');
      expect(carried).toContain('佐藤 美咲');
      expect(JSON.parse(carried)).toMatchObject({
        reads: { contact_list: [{ lang: 'en' }, { lang: 'ja' }], contact_get: [{}, {}] },
        writes: ['contact_update'],
      });
    });

    it("carries nothing of the template's reserved folder: no records file, no digest, as a sample file", async () => {
      const world = await make();
      const entry = world.entry('reserved');
      await world.seedTemplate(entry, { ...SPEC, connectors: [CRM], records: RECORDS });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const paths = await world.paths(guest.workspaceId);
      expect(paths.filter((path) => path.startsWith('demo-template'))).toEqual([]);
    });

    it('leaves out the reads when the seed has no records for them, keeping the writes demo-only', async () => {
      const world = await make();
      const entry = world.entry('no-records');
      await world.seedTemplate(entry, { ...SPEC, connectors: [CRM] });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const [crm] = await world.connectors(guest.workspaceId);
      if (crm === undefined || crm.transport !== 'stdio') throw new Error('no stand-in');
      expect(crm.args?.slice(2)).toEqual(['contact_update']);
    });

    it('leaves out a declared connector that only reads when it has no records', async () => {
      const world = await make();
      const entry = world.entry('reader-only');
      await world.seedTemplate(entry, {
        ...SPEC,
        connectors: [{ kind: 'declared', name: 'qms', reads: ['defect_list'], writes: [] }],
      });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      expect(await world.connectors(guest.workspaceId)).toEqual([]);
    });

    it('answers a read tool that has records only from them: a tool with no set is not offered as a read', async () => {
      const world = await make();
      const entry = world.entry('partial');
      await world.seedTemplate(entry, {
        ...SPEC,
        connectors: [{ ...CRM, reads: ['contact_list', 'deal_list'] }],
        records: RECORDS,
      });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const [crm] = await world.connectors(guest.workspaceId);
      if (crm === undefined || crm.transport !== 'stdio') throw new Error('no stand-in');
      const carried = JSON.parse((crm.args ?? []).slice(2).join('')) as {
        reads: Record<string, unknown>;
      };
      expect(Object.keys(carried.reads)).toEqual(['contact_list']);
    });
  });
}
