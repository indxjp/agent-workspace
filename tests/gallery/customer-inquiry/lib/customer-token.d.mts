// Types for `customer-token.mjs`, which the CRM server (plain Node) and the chat backend share.
export const TOKEN_TTL_SECONDS: number;

export type TokenCheck =
  | { readonly ok: true; readonly customerId: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: 'malformed' | 'signature' | 'expired' };

export function mintCustomerToken(
  secret: string,
  customerId: string,
  options?: { readonly now?: number; readonly ttlSeconds?: number },
): string;

export function verifyCustomerToken(
  secret: string,
  token: unknown,
  options?: { readonly now?: number },
): TokenCheck;
