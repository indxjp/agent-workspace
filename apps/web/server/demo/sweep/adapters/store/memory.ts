import type { DemoSweepStore } from '../../ports';

interface MemoryWorkspace {
  readonly demoExpiresAt: Date | null;
  /** The workspace's usage, by when it happened. */
  readonly usage: readonly {
    readonly at: Date;
    readonly costUsd: number;
    readonly unpriced: boolean;
  }[];
}

/** The memory {@link DemoSweepStore} for tests: the same rules as the repository's statements. */
export class MemoryDemoSweepStore implements DemoSweepStore {
  readonly #workspaces = new Map<string, MemoryWorkspace>();
  readonly #carried = new Map<string, { costUsd: number; unpriced: boolean }>();
  #tokens: { readonly expiresAt: Date; readonly usedAt: Date | null }[] = [];
  #admissions: { readonly at: Date; readonly userId: string | null }[] = [];
  readonly #users = new Map<
    string,
    { readonly createdAt: Date; readonly held: boolean; readonly lead: boolean }
  >();

  public addWorkspace(id: string, workspace: MemoryWorkspace): void {
    this.#workspaces.set(id, workspace);
  }
  public addLoginToken(expiresAt: Date, usedAt: Date | null = null): void {
    this.#tokens.push({ expiresAt, usedAt });
  }
  public addAdmission(at: Date, userId: string | null = null): void {
    this.#admissions.push({ at, userId });
  }
  /**
   * A user; `held` is a membership, an identity or anything else that references it, and `lead`
   * whether its address is a lead (an email link signed it in).
   */
  public addUser(
    id: string,
    user: { readonly createdAt: Date; readonly held: boolean; readonly lead: boolean },
  ): void {
    this.#users.set(id, user);
  }
  public hasUser(id: string): boolean {
    return this.#users.has(id);
  }

  public hasWorkspace(id: string): boolean {
    return this.#workspaces.has(id);
  }
  public get loginTokenCount(): number {
    return this.#tokens.length;
  }
  public get admissionCount(): number {
    return this.#admissions.length;
  }
  /** What the deleted workspaces carried, by UTC day. */
  public get carried(): ReadonlyMap<string, { costUsd: number; unpriced: boolean }> {
    return this.#carried;
  }

  public expiredWorkspaceIds(now: Date, limit: number): Promise<readonly string[]> {
    const due = [...this.#workspaces]
      .filter(([, workspace]) => workspace.demoExpiresAt !== null && workspace.demoExpiresAt <= now)
      .sort(
        ([idA, a], [idB, b]) =>
          (a.demoExpiresAt?.getTime() ?? 0) - (b.demoExpiresAt?.getTime() ?? 0) ||
          idA.localeCompare(idB),
      );
    return Promise.resolve(due.slice(0, limit).map(([id]) => id));
  }

  public deleteExpiredWorkspace(workspaceId: string, now: Date): Promise<boolean> {
    const workspace = this.#workspaces.get(workspaceId);
    if (
      workspace === undefined ||
      workspace.demoExpiresAt === null ||
      workspace.demoExpiresAt > now
    ) {
      return Promise.resolve(false);
    }
    for (const row of workspace.usage) {
      const day = row.at.toISOString().slice(0, 10);
      const found = this.#carried.get(day);
      this.#carried.set(day, {
        costUsd: (found?.costUsd ?? 0) + row.costUsd,
        unpriced: (found?.unpriced ?? false) || row.unpriced,
      });
    }
    this.#workspaces.delete(workspaceId);
    return Promise.resolve(true);
  }

  public deleteLoginTokensBefore(cutoff: Date): Promise<number> {
    const before = this.#tokens.length;
    this.#tokens = this.#tokens.filter(
      (token) => !(token.expiresAt < cutoff || (token.usedAt !== null && token.usedAt < cutoff)),
    );
    return Promise.resolve(before - this.#tokens.length);
  }

  public deleteAdmissionsBefore(cutoff: Date): Promise<number> {
    const before = this.#admissions.length;
    this.#admissions = this.#admissions.filter((admission) => admission.at >= cutoff);
    return Promise.resolve(before - this.#admissions.length);
  }

  public deleteIdleGuestUsersBefore(cutoff: Date): Promise<number> {
    const admitted = new Set(this.#admissions.map((admission) => admission.userId));
    let deleted = 0;
    for (const [id, user] of this.#users) {
      if (user.lead && user.createdAt < cutoff && !user.held && !admitted.has(id)) {
        this.#users.delete(id);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}
