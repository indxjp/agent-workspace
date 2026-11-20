/** The development issuer's small cryptographic helpers: digests, tokens and the EdDSA signer. */
import { createHash, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** Base64url of `bytes`. */
export function base64url(bytes: Buffer | string): string {
  return Buffer.from(bytes).toString('base64url');
}

export function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** Constant-time equality of two strings' SHA-256 digests. */
export function sameSecret(left: string, right: string): boolean {
  return timingSafeEqual(sha256(left), sha256(right));
}

/** 32 random bytes, base64url (43 characters): a client secret, a code or a session id. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The email as the issuer compares it: trimmed and lower-cased. */
function normalisedEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** DI7: one email always has one `sub`: `local:` + base64url(SHA-256(the normalised email)). */
export function devIssuerSubject(email: string): string {
  return `local:${base64url(sha256(normalisedEmail(email)))}`;
}

export interface PublicJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
}

/** RFC 7638: the SHA-256 thumbprint of an OKP key's required members, in lexical order. */
export function thumbprint(jwk: PublicJwk): string {
  return base64url(sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })));
}

/** A function that signs claims as a compact EdDSA JWS with the key identified by `kid`. */
export function signer(privateKey: KeyObject, kid: string) {
  return (claims: Readonly<Record<string, unknown>>): string => {
    const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
    const payload = base64url(JSON.stringify(claims));
    const input = `${header}.${payload}`;
    return `${input}.${base64url(sign(null, Buffer.from(input), privateKey))}`;
  };
}
