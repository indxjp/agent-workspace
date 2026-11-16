/**
 * The hash a public link is looked up by (part 06 step 3). A share token is a bearer secret like an
 * API key, so it is hashed the same way, with the same helper, and the database keeps the hash
 * (`shares.token_hash`) that every lookup compares against.
 */
import { hashApiKeySecret } from '../identity';

/** SHA-256 of `token`, lower-case hex: the value `shares.token_hash` holds for that token. */
export function hashShareToken(token: string): Promise<string> {
  return hashApiKeySecret(token);
}
