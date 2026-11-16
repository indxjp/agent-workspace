import type { EmailLinkSender } from '../../ports';

/**
 * The production sender, chosen by `AW_EMAIL_LINK_SENDER`. Which provider the store sends through
 * is an open decision (spec §08, "Email sender"), so no provider is known yet and every non-empty
 * name is refused at start-up rather than silently sending nothing. A provider is added here, with
 * its own adapter, when that decision is made.
 */
const KNOWN_SENDERS: Readonly<Record<string, () => EmailLinkSender>> = Object.freeze({});

/**
 * The sender `name` selects, or `null` when `name` is unset or blank (the deployment cannot send
 * links; the issue route answers `503 email_link_unavailable`). A name that is set but unknown
 * throws, so a typo is a start-up error and not a deployment that quietly cannot sign anyone in.
 */
export function createEmailLinkSender(name: string | null): EmailLinkSender | null {
  const chosen = name?.trim() ?? '';
  if (chosen === '') return null;
  const make = Object.hasOwn(KNOWN_SENDERS, chosen) ? KNOWN_SENDERS[chosen] : undefined;
  if (make === undefined) {
    const known = Object.keys(KNOWN_SENDERS);
    throw new Error(
      `AW_EMAIL_LINK_SENDER ${JSON.stringify(chosen)} is not a known email-link sender (known: ${
        known.length === 0 ? 'none' : known.join(', ')
      }).`,
    );
  }
  return make();
}
