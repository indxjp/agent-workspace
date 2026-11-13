import { strings, type PortalStrings } from '../strings';

export const dynamic = 'force-dynamic';

type SignInError = keyof PortalStrings['signInErrors'];

/** The sign-in's refusal codes (`/api/sign-in` sends a browser back with one), by what they say. */
const ERRORS: Readonly<Record<string, SignInError>> = {
  sign_in_not_configured: 'notConfigured',
  token_exchange_not_configured: 'notConfigured',
  invalid_client: 'notConfigured',
  subject_token_wrong_issuer: 'notConfigured',
  subject_token_wrong_audience: 'notConfigured',
  subject_not_member: 'notMember',
  sign_in_expired: 'expired',
  sign_in_state_mismatch: 'expired',
  invalid_next: 'expired',
  rate_limited: 'rateLimited',
  issuer_unavailable: 'unavailable',
  upstream_failure: 'unavailable',
};

function errorOf(code: string | string[] | undefined): SignInError | undefined {
  if (typeof code !== 'string') return undefined;
  return Object.hasOwn(ERRORS, code) ? ERRORS[code] : 'refused';
}

export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const next = typeof query['next'] === 'string' ? query['next'] : '/';
  const error = errorOf(query['error']);
  return (
    <main>
      <h1>{strings.signInPageTitle}</h1>
      {error === undefined ? null : (
        <p className="aw-app-alert" role="alert">
          {strings.signInErrors[error]}
        </p>
      )}
      <p>{strings.signInPageBody}</p>
      <p>
        <a className="aw-app-button" href={`/api/sign-in?next=${encodeURIComponent(next)}`}>
          {strings.signIn}
        </a>
      </p>
    </main>
  );
}
