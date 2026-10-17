/**
 * `sendInvitation` — issue #121's "one implementation: manual link mode".
 *
 * G-10 (the Wave 9 plan): this deployment has no mail credential, no SMTP configuration and
 * no template engine, and none of the three is this task's Minimum implementation to build. The
 * interface exists so a real vendor is a second implementation dropped in later, not a redesign of
 * `apps/web/server/invitations/handlers.ts`'s call site — the same shape the models/connectors
 * subsystems use for a provider they cannot install everywhere either.
 *
 * Manual link mode does the only honest thing available: it builds the link and hands it back to
 * the inviter in the `201` response body, the same place `POST /api/api-keys` puts a presented key
 * (§22's "show the raw secret only once"). Nothing here sends mail, opens a socket, or writes
 * anything the inviter did not already receive in that response.
 */

/** What an invitation needs relayed to its recipient, and nothing about who is sending it. */
export interface InvitationToSend {
  readonly invitationId: string;
  readonly email: string;
  /** The plaintext token. Exists in memory only for the duration of this call. */
  readonly token: string;
}

/** What sending produced: the link the inviter relays, by hand, to `invitationEmail`. */
export interface SentInvitation {
  readonly link: string;
}

/** The port. A vendor implementation (SMTP, a transactional-email API) is a second function here. */
export interface SendInvitation {
  send(invitation: InvitationToSend): Promise<SentInvitation>;
}

/**
 * The relative path a future UI (`#122`, W9.7) reads both halves off. There is no page behind it
 * yet — this wave builds no invitation UI, by the card's own "Deliberately not built" — so the
 * "link" is data for a human to relay today and a route for `#122` to parse tomorrow, not a page
 * this deployment serves.
 */
const ACCEPT_PATH = '/accept-invitation';

/**
 * Manual link mode: build the link, send nothing. The inviter reads it off the `201` response and
 * relays it themselves — §21 line `apps/web/server/rbac/api-key.ts` already made once, applied
 * again: the presentation is the delivery mechanism.
 */
export function createManualLinkInvitationSender(): SendInvitation {
  return {
    send({ invitationId, token }: InvitationToSend): Promise<SentInvitation> {
      const params = new URLSearchParams({ id: invitationId, token });
      return Promise.resolve({ link: `${ACCEPT_PATH}?${params.toString()}` });
    },
  };
}
