/**
 * The one place the email-link domain's production adapters are built. The composition root hands
 * this module the `login_tokens` repository it already opened, the deployment's settings and the
 * demo-workspace binder; the routes only read the service and never construct a port.
 */
import type { ClientIdentitySettings } from '../../client-identity';
import type { Clock } from '../../clock';
import type { IdGenerator } from '../../ids';
import { createChallengeVerifier } from '../adapters/challenge/production';
import { createDisposableEmailList } from '../adapters/disposable/disposable';
import { createLoginTokenStore, type LoginTokenRepository } from '../adapters/login-tokens/store';
import { createEmailLinkSender } from '../adapters/sender/production';
import type { EmailLinkService, GuestWorkspaceBinder } from '../ports';
import { createEmailLinkServiceFrom } from '../service';

export interface EmailLinkCompositionDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly clientIdentity: ClientIdentitySettings;
  readonly settings: {
    /** `AW_EMAIL_LINK_BASE_URL`; `null` when unset. */
    readonly linkBaseUrl: string | null;
    /** `AW_EMAIL_LINK_SENDER`; `null` when unset. A set but unknown name throws here. */
    readonly sender: string | null;
    /** `AW_EMAIL_LINK_CHALLENGE`; `null` when unset. A set but unknown name throws here. */
    readonly challenge: string | null;
  };
  readonly loginTokens: LoginTokenRepository;
  readonly binder: GuestWorkspaceBinder;
}

export function createEmailLinkService(deps: EmailLinkCompositionDependencies): EmailLinkService {
  return createEmailLinkServiceFrom({
    clock: deps.clock,
    ids: deps.ids,
    clientIdentity: deps.clientIdentity,
    store: createLoginTokenStore(deps.loginTokens),
    binder: deps.binder,
    sender: createEmailLinkSender(deps.settings.sender),
    linkBaseUrl: deps.settings.linkBaseUrl,
    challenge: createChallengeVerifier(deps.settings.challenge),
    disposable: createDisposableEmailList(),
  });
}
