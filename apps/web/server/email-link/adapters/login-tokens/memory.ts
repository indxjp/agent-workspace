import type { ConsumeOutcome, LoginTokenRecord, LoginTokenStore } from '../../ports';

interface Row extends LoginTokenRecord {
  usedAt: Date | null;
}

/** The `login_tokens` table in memory. The same answers as the PostgreSQL adapter, for tests. */
export class MemoryLoginTokenStore implements LoginTokenStore {
  readonly #rows: Row[] = [];

  /** Synchronous in its body, so of two concurrent calls the first finds the room and takes it. */
  public reserve(
    record: LoginTokenRecord,
    window: { readonly since: Date; readonly limit: number },
  ): Promise<boolean> {
    if (this.#rows.some((row) => row.tokenHash === record.tokenHash)) {
      return Promise.reject(new Error('duplicate token hash'));
    }
    const issued = this.#rows.filter(
      (row) =>
        row.emailHash === record.emailHash && row.createdAt.getTime() >= window.since.getTime(),
    ).length;
    if (issued >= window.limit) return Promise.resolve(false);
    this.#rows.push({ ...record, usedAt: null });
    return Promise.resolve(true);
  }

  public release(id: string): Promise<void> {
    const index = this.#rows.findIndex((row) => row.id === id);
    if (index >= 0) this.#rows.splice(index, 1);
    return Promise.resolve();
  }

  /** Synchronous in its body, so of two concurrent calls the first finds the row unused. */
  public consume(input: {
    readonly tokenHash: string;
    readonly emailHash: string;
    readonly now: Date;
  }): Promise<ConsumeOutcome> {
    const row = this.#rows.find(
      (candidate) =>
        candidate.tokenHash === input.tokenHash &&
        candidate.emailHash === input.emailHash &&
        candidate.usedAt === null &&
        candidate.expiresAt.getTime() > input.now.getTime(),
    );
    if (row === undefined) return Promise.resolve({ kind: 'refused' });
    row.usedAt = input.now;
    return Promise.resolve({ kind: 'consumed' });
  }

  /** What the table holds, for a test that checks nothing secret is stored. */
  public snapshot(): readonly (LoginTokenRecord & { readonly usedAt: Date | null })[] {
    return this.#rows.map((row) => ({ ...row }));
  }
}
