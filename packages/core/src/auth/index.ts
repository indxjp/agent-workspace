/** Generic OIDC configuration shared by the control plane and its persistence adapters. */
export interface OidcConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

export interface OidcIdentity {
  readonly subject: string;
  readonly email: string;
  readonly name: string | null;
}
