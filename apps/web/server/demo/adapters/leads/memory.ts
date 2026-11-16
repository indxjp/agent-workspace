import type { LeadStore, StoreEnquiryDetail } from '../../ports';

/** One lead as the memory adapter keeps it. */
export interface MemoryLead {
  readonly email: string;
  readonly entries: readonly string[];
  readonly enquiry: string | null;
  readonly enquirySetup: StoreEnquiryDetail | null;
  readonly launchNotices: readonly string[];
  readonly createdAt: Date;
  readonly lastContactAt: Date;
}

/** The memory {@link LeadStore} for tests: the same rules as the `store_leads` statements. */
export class MemoryLeadStore implements LeadStore {
  readonly #leads = new Map<string, MemoryLead>();

  /** Every lead, by address. */
  public get leads(): readonly MemoryLead[] {
    return [...this.#leads.values()].sort((a, b) => a.email.localeCompare(b.email));
  }

  public recordContact(input: {
    readonly email: string;
    readonly entry: string | null;
    readonly now: Date;
  }): Promise<void> {
    const found = this.#leads.get(input.email);
    const entries = found?.entries ?? [];
    return this.#write(input.email, input.now, {
      entries:
        input.entry === null || entries.includes(input.entry) ? entries : [...entries, input.entry],
    });
  }

  public recordEnquiry(input: {
    readonly email: string;
    readonly message: string;
    readonly detail: StoreEnquiryDetail | null;
    readonly now: Date;
  }): Promise<void> {
    return this.#write(input.email, input.now, {
      enquiry: input.message,
      enquirySetup: input.detail,
    });
  }

  public recordLaunchNotice(input: {
    readonly email: string;
    readonly entry: string;
    readonly now: Date;
  }): Promise<void> {
    const notices = this.#leads.get(input.email)?.launchNotices ?? [];
    return this.#write(input.email, input.now, {
      launchNotices: notices.includes(input.entry) ? notices : [...notices, input.entry],
    });
  }

  /** Make the lead or update it with `change`; the last contact never moves back. */
  #write(
    email: string,
    now: Date,
    change: Partial<Omit<MemoryLead, 'email' | 'createdAt' | 'lastContactAt'>>,
  ): Promise<void> {
    const found = this.#leads.get(email);
    this.#leads.set(email, {
      email,
      entries: [],
      enquiry: null,
      enquirySetup: null,
      launchNotices: [],
      ...found,
      ...change,
      createdAt: found?.createdAt ?? now,
      lastContactAt: found !== undefined && found.lastContactAt > now ? found.lastContactAt : now,
    });
    return Promise.resolve();
  }

  public deleteLastContactBefore(cutoff: Date): Promise<number> {
    let deleted = 0;
    for (const [email, lead] of this.#leads) {
      if (lead.lastContactAt < cutoff) {
        this.#leads.delete(email);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}
