/**
 * What the desk's scripted Agent Workspace streams for each run: the event-stream text a real
 * run's `GET /api/runs/:id/events` would carry, built from the same frame shapes the platform
 * writes (`run.status`, `agent.tool.call`, `agent.tool.result`, `agent.message`, then `done`).
 */
import type { RunApprovalCall, RunResource } from '@indx-workspace/contracts/runs';

/**
 * What a scripted run does: triage a ticket, carry out the decision on its paused call, or rewrite
 * a page (issue #1521).
 */
export type RunScript = 'triage' | 'approved' | 'rejected' | 'rewrite';

/** The call the triage run pauses on (ADR-0145): give the ticket to Net. */
export const ASSIGN_TO_NET: RunApprovalCall = Object.freeze({
  toolName: 'ticket_update',
  canonicalCall: '{"assignee":"Net"}',
});

/** The assignee the approved call writes. */
export const APPROVED_ASSIGNEE = 'Net';

/** The body the writer's rewrite saves, as the markdown `page_update` takes. */
export const REWRITTEN_MARKDOWN = [
  '## Clearing a paper jam',
  '1. Open the front tray.',
  '2. Pull the jammed sheet out gently.',
  'Ask Net when the printer still jams.',
].join('\n\n');

/** The status a run of each script ends its stream with. */
export const STATUS_AFTER: Readonly<Record<RunScript, RunResource['status']>> = {
  triage: 'awaiting_approval',
  approved: 'completed',
  rejected: 'completed',
  rewrite: 'completed',
};

const ENGINE = { engine: 'claude-agent-sdk', raw: null } as const;

type Frame = readonly [event: string, data: unknown];

const running: Frame = ['run.status', { status: 'running', error: null }];

function toolCall(toolCallId: string, name: string, input: unknown): Frame {
  return [
    'agent.tool.call',
    { frame: 'agent.tool.call', ...ENGINE, toolCallId, name, kind: 'read', input },
  ];
}

function toolResult(toolCallId: string, output: string): Frame {
  return [
    'agent.tool.result',
    {
      frame: 'agent.tool.result',
      ...ENGINE,
      toolCallId,
      status: 'completed',
      output,
      isError: false,
    },
  ];
}

function message(messageId: string, text: string): Frame {
  return [
    'agent.message',
    {
      frame: 'agent.message',
      ...ENGINE,
      messageId,
      role: 'assistant',
      blocks: [{ type: 'text', text }],
    },
  ];
}

function framesOf(script: RunScript, number: string): readonly Frame[] {
  switch (script) {
    case 'triage':
      return [
        running,
        toolCall('t1', 'reading ticket', { ticket: number }),
        toolResult('t1', `${number}: the printer on floor 3 is jammed`),
        toolCall('t2', 'searching kb_article', { q: 'printer jam floor 3' }),
        toolResult('t2', 'KB-17: printers on floor 3 belong to Net'),
        message(
          'm1',
          `${number} is a printer fault; Net looks after floor 3. I would assign it to Net.`,
        ),
      ];
    case 'approved':
      return [
        running,
        toolCall('t3', 'ticket_update', { assignee: APPROVED_ASSIGNEE }),
        toolResult('t3', `${number} assigned to ${APPROVED_ASSIGNEE}`),
        message('m2', `Assigned ${number} to ${APPROVED_ASSIGNEE}.`),
      ];
    case 'rejected':
      return [running, message('m2', `Understood: ${number} is left as it is.`)];
    case 'rewrite':
      return [
        running,
        toolCall('w1', 'page_get', { page: number }),
        toolResult('w1', `${number}: read`),
        toolCall('w2', 'page_update', { page: number }),
        toolResult('w2', `${number}: saved as a new revision`),
        message('m3', `I rewrote ${number} as steps, in a new revision.`),
      ];
  }
}

/**
 * The event-stream text of a run of `script` about ticket `number` (a page's title for `rewrite`): its frames with ids from 1,
 * the run's closing status, and `done`.
 */
export function eventStreamOf(script: RunScript, number: string): string {
  const frames: readonly Frame[] = [
    ...framesOf(script, number),
    ['run.status', { status: STATUS_AFTER[script], error: null }],
  ];
  return [
    ...frames.map(
      ([event, data], index) =>
        `event: ${event}\nid: ${String(index + 1)}\ndata: ${JSON.stringify(data)}\n\n`,
    ),
    'event: done\ndata: {}\n\n',
  ].join('');
}
