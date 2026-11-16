// The desk's SLA: how long a ticket may stay open, unchanged, at each priority.
// shortcut: a constant table, not sla_policies rows; move it to a resource when someone needs to
// edit SLAs while the app runs.
const HOUR_MS = 60 * 60 * 1000;

export const SLA_MS = { p1: HOUR_MS, p2: 4 * HOUR_MS, p3: 24 * HOUR_MS, p4: 72 * HOUR_MS } as const;

export type Priority = keyof typeof SLA_MS;

/** The statuses the sweep looks at: a ticket nobody has resolved, closed or put on hold. */
export const OPEN_STATUSES = ['new', 'in_progress'] as const;

/**
 * Whether `ticket` is open past its SLA at `now`. The clock runs from the ticket's last change,
 * so an escalation (a change) starts it again and a ticket is escalated once per SLA period.
 */
export function isBreached(
  ticket: { readonly status: string; readonly priority: Priority; readonly updated_at: string },
  now: Date,
): boolean {
  if (!(OPEN_STATUSES as readonly string[]).includes(ticket.status)) return false;
  return now.getTime() - Date.parse(ticket.updated_at) > SLA_MS[ticket.priority];
}

/** One priority up; p1 stays p1. */
export function raised(priority: Priority): Priority {
  return priority === 'p4' ? 'p3' : priority === 'p3' ? 'p2' : 'p1';
}
