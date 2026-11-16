/**
 * What the maintenance verdicts need of the database, as the domain states it (the database root's
 * `demoEntryStates` repository fits it structurally).
 */
export interface DemoEntryStates {
  /** Keep `state` and its reason as the entry's verdict, replacing the earlier one. */
  set(input: {
    readonly entry: string;
    readonly state: 'available' | 'maintenance';
    readonly reason: string;
    readonly now: Date;
  }): Promise<void>;
  /** The slugs of the entries whose verdict is `maintenance`. */
  underMaintenance(): Promise<readonly string[]>;
}
