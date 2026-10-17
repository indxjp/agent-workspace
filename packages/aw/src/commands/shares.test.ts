import {
  AuditEventListResponseSchema,
  AuditEventSchema,
  RunTelemetrySchema,
} from '@indx-workspace/contracts/observability';
import { ShareListItemSchema } from '@indx-workspace/contracts/shares';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, runCli, stdoutJson } from '../testing.js';

describe('aw shares', () => {
  it('lists and revokes', async () => {
    const list = await runCli(['shares', 'list', '--json'], {
      route: () => json(200, { shares: [FIXTURES.share] }),
    });
    expect(ShareListItemSchema.array().parse(stdoutJson(list))).toEqual([FIXTURES.share]);
    const human = await runCli(['shares', 'list'], {
      route: () => json(200, { shares: [FIXTURES.share] }),
    });
    expect(human.stdout).toContain('/p/token');
    const revoke = await runCli(['shares', 'revoke', 'sh-1'], { route: () => json(204, null) });
    expect(revoke.code).toBe(EXIT_CODE.ok);
    expect(revoke.calls[0]?.method).toBe('DELETE');
    expect(revoke.calls[0]?.url.pathname).toBe('/api/shares/sh-1');
  });
});

describe('aw metrics / audit', () => {
  it('recent-runs and audit list --limit round-trip through the contract', async () => {
    const metrics = await runCli(['metrics', 'recent-runs', '--json'], {
      route: () => json(200, { runs: [FIXTURES.telemetry] }),
    });
    expect(RunTelemetrySchema.array().parse(stdoutJson(metrics))).toEqual([FIXTURES.telemetry]);
    const audit = await runCli(['audit', 'list', '--limit', '5', '--cursor', 'c-1', '--json'], {
      route: () => json(200, { events: [FIXTURES.auditEvent], nextCursor: 'c-2' }),
    });
    expect(audit.calls[0]?.url.search).toBe('?limit=5&cursor=c-1');
    expect(AuditEventListResponseSchema.parse(stdoutJson(audit))).toEqual({
      events: [FIXTURES.auditEvent],
      nextCursor: 'c-2',
    });
    const human = await runCli(['audit', 'list', '--limit', '1'], {
      route: () => json(200, { events: [FIXTURES.auditEvent], nextCursor: 'c-2' }),
    });
    expect(human.stderr).toContain('next page: --cursor c-2');
    const bad = await runCli(['audit', 'list', '--limit', 'many']);
    expect(bad.code).toBe(EXIT_CODE.usage);
  });

  it('audit list --all walks every page and prints the rows of all of them', async () => {
    const second = { ...FIXTURES.auditEvent, id: '88888888-8888-4888-8888-888888888888' };
    const all = await runCli(['audit', 'list', '--all', '--limit', '1', '--json'], {
      route: (request) =>
        request.url.searchParams.get('cursor') === 'c-2'
          ? json(200, { events: [second], nextCursor: null })
          : json(200, { events: [FIXTURES.auditEvent], nextCursor: 'c-2' }),
    });
    expect(all.calls.map((call) => call.url.search)).toEqual(['?limit=1', '?limit=1&cursor=c-2']);
    expect(AuditEventSchema.array().parse(stdoutJson(all))).toEqual([FIXTURES.auditEvent, second]);
  });
});
