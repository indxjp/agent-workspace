/** Where the E2E plants its sign-in proof route in the generated app, relative to the project. */
export const SIGN_IN_PROOF_ROUTE = 'app/api/e2e-sign-in/route.ts';

/**
 * The planted route (issue #2075): `GET` names the app's issuer and client id (never a secret);
 * `POST { code, verifier, redirectUri }` redeems the code at the issuer's token endpoint with the app's
 * `client_secret_basic` pair and trades the ID token with `aw.auth.exchange`, answering only the
 * `awo_live_` token. It stands in for U3.6-b's `/api/sign-in/callback`, which keeps that token in a
 * cookie instead; it lives only in the E2E's temporary project.
 */
export function signInProofRoute() {
  return `import { createClient } from '@indx-workspace/sdk';

export function GET(): Response {
  return Response.json({
    issuer: process.env['AW_OIDC_ISSUER_URL'] ?? null,
    clientId: process.env['AW_OIDC_CLIENT_ID'] ?? null,
    appBackend: process.env['AW_APP_CLIENT_ID'] !== undefined,
  });
}

export async function POST(request: Request): Promise<Response> {
  const env = process.env;
  const { code, verifier, redirectUri } = (await request.json()) as {
    code: string;
    verifier: string;
    redirectUri: string;
  };
  const pair = \`\${encodeURIComponent(env['AW_OIDC_CLIENT_ID'] ?? '')}:\${encodeURIComponent(env['AW_OIDC_CLIENT_SECRET'] ?? '')}\`;
  const answered = await fetch(\`\${env['AW_OIDC_ISSUER_URL'] ?? ''}/token\`, {
    method: 'POST',
    headers: {
      authorization: \`Basic \${Buffer.from(pair).toString('base64')}\`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (answered.status !== 200) {
    const { error } = (await answered.json()) as { error?: string };
    return Response.json({ step: 'token', status: answered.status, error }, { status: 502 });
  }
  const { id_token: idToken } = (await answered.json()) as { id_token: string };
  const aw = createClient({ baseUrl: env['AW_URL'] ?? '', auth: { kind: 'session' } });
  const exchanged = await aw.auth.exchange({
    clientId: env['AW_APP_CLIENT_ID'] ?? '',
    clientSecret: env['AW_APP_CLIENT_SECRET'] ?? '',
    idToken,
  });
  return Response.json({ accessToken: exchanged.access_token, expiresIn: exchanged.expires_in });
}
`;
}
