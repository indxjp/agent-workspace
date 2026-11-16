/**
 * The Agent Store demo's ports (internal spec, "How Try it works", "Abuse controls" and "Privacy
 * notice and lead retention").
 *
 * The demo domain follows the Builder's layout (AGENTS.md, hexagonal rule 1): rules in `core/` (no
 * I/O), these ports, one folder per port under `adapters/` with a production and a memory adapter
 * and one contract test run against both, and the wiring in `transport/composition.ts`. Time comes
 * from the `Clock`.
 *
 * Three jobs live here, each in its own folder:
 *
 * - `provision/` — the demo provisioner. It is the `GuestWorkspaceBinder` the email-link sign-in
 *   calls (`../email-link/ports.ts`): it binds the guest through the RBAC directory, marks the
 *   workspace with its end (`workspaces.demo_expires_at`), copies the chosen entry's demo template
 *   (agent and `demo.seed` sample data) into it with the per-run caps set on the agent, grants the
 *   guest that agent, and records the lead.
 * - `caps/` — the run-start gate of a demo workspace: runs per person and per client address in
 *   24 hours (`demo_run_admissions`) and the site-wide daily cost (live demo workspaces plus
 *   `demo_daily_costs`). The run API reaches it through a type the runs domain declares, so the
 *   execution context never imports this one.
 * - `sweep/` — the scheduled jobs on the trigger driver: delete expired demo workspaces (carrying
 *   their spend into `demo_daily_costs` first), delete spent or expired `login_tokens`, prune old
 *   `demo_run_admissions`, and delete leads past the retention period.
 *
 * Each job's own ports are in its folder (`provision/ports.ts`, `caps/ports.ts`,
 * `sweep/ports.ts`). The one port two of them share is here, {@link LeadStore}: the provisioner
 * records contacts, the sweep deletes old leads.
 */

import type { StoreLeadRequest } from '@indx-workspace/contracts/email-link';

/** What an enquiry was about: the catalog entry and the Customize-tab setup, when it named any. */
export type StoreEnquiryDetail = Pick<
  Extract<StoreLeadRequest, { readonly kind: 'enquiry' }>,
  'entry' | 'setup'
>;

/** The `store_leads` table. PostgreSQL in production, memory in tests; one contract test for both. */
export interface LeadStore {
  /**
   * Record a contact from `email` (lower-cased) at `now`: makes the lead or updates it. `entry`, the
   * catalog entry whose demo was opened, joins the lead's entries once. The last contact never
   * moves back.
   */
  recordContact(input: {
    readonly email: string;
    readonly entry: string | null;
    readonly now: Date;
  }): Promise<void>;
  /**
   * Keep `message` as the enquiry of the lead for `email` (made if new), with what it was about. A
   * later enquiry replaces the earlier one. The last contact moves to `now`, never back.
   */
  recordEnquiry(input: {
    readonly email: string;
    readonly message: string;
    readonly detail: StoreEnquiryDetail | null;
    readonly now: Date;
  }): Promise<void>;
  /** Add `entry` to the lead's launch notices, once; the lead is made if new. Last contact as above. */
  recordLaunchNotice(input: {
    readonly email: string;
    readonly entry: string;
    readonly now: Date;
  }): Promise<void>;
  /** Delete every lead last contacted before `cutoff`; how many went. */
  deleteLastContactBefore(cutoff: Date): Promise<number>;
}
