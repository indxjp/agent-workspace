import type { DemoAdmission, DemoRunAdmissions } from '../../ports';

interface Admitted {
  readonly userId: string;
  readonly clientKey: string;
  readonly at: Date;
}

/** The memory {@link DemoRunAdmissions} for tests: the same counting rules as the table. */
export class MemoryDemoRunAdmissions implements DemoRunAdmissions {
  readonly #rows: Admitted[] = [];

  /** How many admissions are recorded, for tests. */
  public get count(): number {
    return this.#rows.length;
  }

  public countSince(userId: string, since: Date): Promise<number> {
    return Promise.resolve(
      this.#rows.filter((row) => row.userId === userId && row.at >= since).length,
    );
  }

  public admit(input: {
    readonly userId: string;
    readonly clientKey: string;
    readonly now: Date;
    readonly since: Date;
    readonly personLimit: number;
    readonly clientLimit: number;
  }): Promise<DemoAdmission> {
    // One synchronous step: nothing interleaves between the counts and the insert.
    const inWindow = this.#rows.filter((row) => row.at >= input.since);
    if (inWindow.filter((row) => row.userId === input.userId).length >= input.personLimit) {
      return Promise.resolve({ kind: 'person_limit' });
    }
    if (inWindow.filter((row) => row.clientKey === input.clientKey).length >= input.clientLimit) {
      return Promise.resolve({ kind: 'client_limit' });
    }
    this.#rows.push({ userId: input.userId, clientKey: input.clientKey, at: input.now });
    return Promise.resolve({ kind: 'admitted' });
  }
}
