/**
 * The public-source connector a use-cases entry's recording plays against: the entry's own code
 * tool on `aw-dev-tools`, answered from the snapshot the project ships, its refusals answered as
 * errors, and nothing for an entry that reads no public source.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';

import { publicSourceConnectors } from './use-case-desk.ts';

const call = (slug: string, tool: string, args: Record<string, unknown>) => {
  const connector = publicSourceConnectors(slug)[AW_DEV_TOOLS_CONNECTOR];
  if (connector === undefined) throw new Error(`${slug} has no public-source connector`);
  return connector.session.call(tool, args);
};

describe('the public-source connector of a recording', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers the entry’s tool from its shipped snapshot, with no network', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('no network in a recording')));
    vi.stubGlobal('fetch', fetch);
    const answer = await call('screening', 'check_public_lists', { query: 'Vashkin' });
    expect(answer.isError).toBe(false);
    expect(JSON.parse(answer.text)).toMatchObject({
      mode: 'snapshot',
      asOf: '2026-11-16',
      records: [{ id: 'FSL-2207' }],
    });
    const market = await call('market', 'read_market_stats', { query: 'shipments' });
    expect(JSON.parse(market.text)).toMatchObject({ asOf: '2026-11-14' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers a refused query and another tool as errors', async () => {
    const refused = await call('screening', 'check_public_lists', { query: 'x', page: 2 });
    expect(refused.isError).toBe(true);
    const other = await call('screening', 'read_market_stats', { query: 'x' });
    expect(other).toEqual({
      text: `${AW_DEV_TOOLS_CONNECTOR} has no tool read_market_stats`,
      isError: true,
    });
  });

  it('is none for an entry that reads no public source', () => {
    expect(publicSourceConnectors('nda')).toEqual({});
  });
});
