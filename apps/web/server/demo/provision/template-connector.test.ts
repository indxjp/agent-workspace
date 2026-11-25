import { describe, expect, it } from 'vitest';

import { planDemoConnector } from './outside-tools';
import {
  DEMO_TEMPLATE_CONNECTOR_COMMAND,
  declaredTools,
  templateConnectorArgs,
} from './template-connector';

const RECORDED = [{ write: 'event_create', kind: 'calendar', read: 'event_list' }] as const;

describe("a template connector row's declaration", () => {
  it('keeps the reads, the writes and the recorded writes, and reads them back', () => {
    const args = templateConnectorArgs(['event_list'], ['event_create', 'invite_send'], RECORDED);
    expect(args).toEqual([
      'read:event_list',
      'write:event_create',
      'write:invite_send',
      'record:event_create:calendar:event_list',
    ]);
    expect(declaredTools({ command: DEMO_TEMPLATE_CONNECTOR_COMMAND, args })).toEqual({
      reads: ['event_list'],
      writes: ['event_create', 'invite_send'],
      recorded: RECORDED,
    });
  });

  it('records nothing for a row made before recorded writes, and is not a declaration without its command', () => {
    const args = templateConnectorArgs(['event_list'], ['event_create']);
    expect(declaredTools({ command: DEMO_TEMPLATE_CONNECTOR_COMMAND, args })?.recorded).toEqual([]);
    expect(declaredTools({ command: 'npx', args })).toBeNull();
    expect(declaredTools({ command: DEMO_TEMPLATE_CONNECTOR_COMMAND, args: null })).toEqual({
      reads: [],
      writes: [],
      recorded: [],
    });
  });

  it('skips a recorded argument that is not one: an unknown kind, a missing or an extra part', () => {
    const args = [
      'record:event_create:email:event_list',
      'record:event_create:calendar',
      'record:event_create:calendar:event_list:more',
    ];
    expect(declaredTools({ command: DEMO_TEMPLATE_CONNECTOR_COMMAND, args })?.recorded).toEqual([]);
  });

  it('plans a stand-in that keeps the recorded writes, and none for any other connector', () => {
    const declared = {
      id: 'c1',
      workspaceId: 'w1',
      name: 'calendar',
      transport: 'stdio' as const,
      command: DEMO_TEMPLATE_CONNECTOR_COMMAND,
      args: templateConnectorArgs(['event_list'], ['event_create'], RECORDED),
      url: null,
      authType: 'none' as const,
      hasCredential: false,
      enabled: true,
      createdBy: null,
      ownerPrincipalId: 'p1',
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
    };
    expect(planDemoConnector(declared)).toEqual({
      kind: 'stand-in',
      name: 'calendar',
      tools: ['event_create'],
      reads: ['event_list'],
      recorded: RECORDED,
    });
    expect(planDemoConnector({ ...declared, command: 'npx', args: [] })).toMatchObject({
      recorded: [],
    });
  });
});
