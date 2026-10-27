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

  // @story US-STO-04
  it('[US-STO-04][api][cli] aw audit list --action file-deleted lists only deletes', async () => {
    const deleted = { ...FIXTURES.auditEvent, action: 'file-deleted' as const };
    const listed = await runCli(['audit', 'list', '--action', 'file-deleted', '--json'], {
      route: (request) =>
        json(200, {
          events: request.url.searchParams.get('action') === 'file-deleted' ? [deleted] : [],
          nextCursor: null,
        }),
    });
    expect(listed.calls[0]?.url.search).toBe('?action=file-deleted');
    expect(AuditEventListResponseSchema.parse(stdoutJson(listed))).toEqual({
      events: [deleted],
      nextCursor: null,
    });
    const bad = await runCli(['audit', 'list', '--action', 'no-such-action']);
    expect(bad.code).toBe(EXIT_CODE.usage);
    expect(bad.stderr).toContain('--action must be one of');
  });

  it('[US-BLD-05][api][cli] aw audit list prints the agent-created row of a Builder save', async () => {
    const created = {
      ...FIXTURES.auditEvent,
      action: 'agent-created' as const,
      builderRunId: 'run-1',
    };
    const route = () => json(200, { events: [created], nextCursor: null });
    const listed = await runCli(['audit', 'list', '--action', 'agent-created'], { route });
    expect(listed.stdout).toContain('agent-created');
    expect(listed.stdout).toContain('builderRunId');
    expect(listed.stdout).toContain('run-1');
    const raw = await runCli(['audit', 'list', '--action', 'agent-created', '--json'], { route });
    expect(AuditEventListResponseSchema.parse(stdoutJson(raw)).events[0]?.builderRunId).toBe(
      'run-1',
    );
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
