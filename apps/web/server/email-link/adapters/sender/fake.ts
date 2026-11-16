import type { EmailLinkMessage, EmailLinkSender } from '../../ports';

/** A sender for tests: it records every message and sends nothing. Never built in production. */
export class FakeEmailLinkSender implements EmailLinkSender {
  readonly #sent: EmailLinkMessage[] = [];
  #failure: Error | null = null;

  public send(message: EmailLinkMessage): Promise<void> {
    if (this.#failure !== null) return Promise.reject(this.#failure);
    this.#sent.push(message);
    return Promise.resolve();
  }

  /** Every message sent so far, oldest first. */
  public get messages(): readonly EmailLinkMessage[] {
    return this.#sent;
  }

  /** Make every later `send` fail, as an unreachable provider would. */
  public failWith(error: Error): void {
    this.#failure = error;
  }
}
