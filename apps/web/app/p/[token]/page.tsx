import { log } from '../../../server/telemetry/logger';
import { ShareService } from '../../../server/shares/core/service';
import { applicationContext } from '../../../server/application-context';
import { PublicMessageForm } from '../../../components/shares/public-message-form';
import { SharedSnapshot } from '../../../components/shares/shared-snapshot';
import { runnablePublicLinksEnabled } from '../../../server/shares/runnable/feature';
import { DomainError } from '../../../server/errors';
import { resolvePublicShare } from '../../../server/shares/core/http';
export const dynamic = 'force-dynamic';
export default async function PublicSharePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ passphrase?: string }>;
}) {
  const { token } = await params;
  const runtime = applicationContext()?.shares;
  const resolved = runtime ? await resolvePublicShare(runtime, token) : null;
  if (!resolved)
    return (
      <main className="mx-auto max-w-[760px] p-8">
        <h1>Link unavailable</h1>
      </main>
    );
  try {
    const share = await new ShareService(resolved.sharing).resolve(
      token,
      (await searchParams).passphrase,
    );
    return (
      <main className="mx-auto max-w-[760px] p-8">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">
          Shared {share.subjectType}
        </div>
        <h1 className="mt-2 text-[26px]">{share.subjectLabel}</h1>
        <SharedSnapshot subjectType={share.subjectType} snapshot={share.snapshot} />
        {share.mode === 'runnable' && runnablePublicLinksEnabled() ? (
          <PublicMessageForm token={token} passphraseRequired={share.passphraseHash !== null} />
        ) : null}
      </main>
    );
  } catch (error) {
    // A protected runnable share stays usable without `?passphrase=` in the URL: the visitor types
    // it into the form, which sends it in the POST body and the messages route verifies it.
    if (
      error instanceof DomainError &&
      error.code === 'invalid_passphrase' &&
      runnablePublicLinksEnabled() &&
      (await resolved.sharing.shares.findByToken(token))?.mode === 'runnable'
    ) {
      return (
        <main className="mx-auto max-w-[760px] p-8">
          <h1>Protected link</h1>
          <p>Enter the passphrase you were given to send a message.</p>
          <PublicMessageForm token={token} passphraseRequired />
        </main>
      );
    }
    if (!(error instanceof DomainError)) {
      log.error('[public-shares] render-public-share failed', { error });
    }
    return (
      <main className="mx-auto max-w-[760px] p-8">
        <h1>Link unavailable</h1>
        <p>{error instanceof DomainError ? error.publicMessage : 'This link cannot be opened.'}</p>
      </main>
    );
  }
}
