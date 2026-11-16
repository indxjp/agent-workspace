/**
 * The demo run caps' ports (internal spec, "Abuse controls"). A demo run start (a run in a
 * workspace whose `demo_expires_at` is set) is admitted only while the person and the client
 * address are under their 24-hour counts and the site's demo spend today is under its cap. A
 * refusal is one of `DEMO_RUN_START_PROBLEM_CODES`; the run API reaches the gate through a type
 * the runs domain declares, so the execution context never imports this one.
 */

/** What one admission attempt found. */
export type DemoAdmission =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'person_limit' }
  | { readonly kind: 'client_limit' };

/** The `demo_run_admissions` table. PostgreSQL in production, memory in tests. */
export interface DemoRunAdmissions {
  /** How many demo runs the person started at or after `since`: the count `admit` limits. */
  countSince(userId: string, since: Date): Promise<number>;
  /**
   * Admit one demo run start, atomically across replicas: count the person's and the client's
   * admissions at or after `since`, and record one at `now` only if the person is under
   * `personLimit` and the client under `clientLimit`. Of two concurrent calls at the last place,
   * one is admitted.
   */
  admit(input: {
    readonly userId: string;
    readonly clientKey: string;
    readonly now: Date;
    readonly since: Date;
    readonly personLimit: number;
    readonly clientLimit: number;
  }): Promise<DemoAdmission>;
}

/** The whole site's demo model spend on one UTC day. */
export interface DemoDaySpend {
  readonly costUsd: number;
  /** Some of the day's spend has no price, so the sum is a floor and the cap cannot be met. */
  readonly unpricedUsage: boolean;
}

/** Every demo workspace's spend: the live ones' usage plus `demo_daily_costs` for deleted ones. */
export interface DemoSpend {
  /** The spend on the UTC day that starts at `dayStart`. Rejects when it cannot be read. */
  spentOn(dayStart: Date): Promise<DemoDaySpend>;
}
