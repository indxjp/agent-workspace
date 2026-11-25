/**
 * The one signed-token codec (refactoring part 06, step 6). The session, workspace-selection and
 * invitation-identity cookies are all `<version>.<payload>.<signature>`: the payload is base64url
 * of a JSON object, the signature is base64url of HMAC-SHA-256 over `<version>.<payload>` under the
 * token's purpose key (`./key-ring.ts`). Each module used to carry its own copy of this code; they
 * now seal and open through here and keep only what differs: the version tag, the key, the claims
 * and the words of each refusal.
 *
 * This is a `core/`, so it may not touch the `crypto` global (`domain-core-is-pure` and the core
 * globals ban): the caller passes the Web Crypto port, `crypto.subtle`, as `./key-ring.ts` does.
 *
 * {@link openSignedToken} checks in a fixed order, and the order is the security property: the
 * signature is verified before the payload is decoded or parsed, so no attacker-controlled JSON
 * reaches `JSON.parse` on the strength of a bad MAC. The comparison is `subtle.verify`, which is
 * constant-time by contract; nothing here compares two MACs itself.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The three Web Crypto calls the codec needs; `crypto.subtle` satisfies it. */
export type HmacPort = Pick<SubtleCrypto, 'importKey' | 'sign' | 'verify'>;

/** Unpadded base64url (RFC 4648 §5) of `bytes`. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * The bytes of unpadded base64url `text`, or `null` when it holds any other character or cannot be
 * decoded. The `Uint8Array<ArrayBuffer>` is not decoration: Web Crypto's `BufferSource` excludes
 * views backed by a `SharedArrayBuffer`, so the buffer is allocated explicitly.
 */
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) return null;
  const padding = (4 - (text.length % 4)) % 4;
  const padded = text.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat(padding);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** An HMAC-SHA-256 key for sealing and opening, from a purpose key's bytes. */
export function importHmacKey(
  subtle: Pick<HmacPort, 'importKey'>,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  return subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** `<version>.<base64url JSON of payload>.<base64url HMAC>`. The caller has decided the payload is true. */
export async function sealSignedToken(
  subtle: Pick<HmacPort, 'sign'>,
  key: CryptoKey,
  version: string,
  payload: unknown,
): Promise<string> {
  const signed = `${version}.${encodeBase64Url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await subtle.sign('HMAC', key, encoder.encode(signed));
  return `${signed}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Why {@link openSignedToken} refused, in the order it checks. Each module words its own refusal. */
export type SignedTokenFailure =
  | { readonly kind: 'parts-count'; readonly count: number }
  | { readonly kind: 'version' }
  | { readonly kind: 'signature-encoding' }
  | { readonly kind: 'signature' }
  | { readonly kind: 'payload-encoding' }
  | { readonly kind: 'payload-json' }
  | { readonly kind: 'payload-not-object' };

/**
 * The words for `failure` in a refusal's `reason`, for an operator's log. A module whose words
 * differ for one kind (its own token's name, say) says so before falling back to these.
 */
export function signedTokenRefusal(failure: SignedTokenFailure): string {
  switch (failure.kind) {
    case 'parts-count':
      return `token has ${String(failure.count)} parts, expected 3`;
    case 'version':
      return 'token version tag is not the one this build issues';
    case 'signature-encoding':
      return 'signature segment is not base64url';
    case 'signature':
      return 'signature does not verify';
    case 'payload-encoding':
      return 'payload segment is not base64url';
    case 'payload-json':
      return 'payload is not JSON';
    case 'payload-not-object':
      return 'payload is not a JSON object';
  }
}

export type SignedTokenOpening =
  | { readonly ok: true; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly failure: SignedTokenFailure };

function refused(failure: SignedTokenFailure): SignedTokenOpening {
  return { ok: false, failure };
}

/**
 * The payload of `token`, if it carries `version` and a signature that verifies under `key`. The
 * payload is decoded and parsed only after the signature verified, and it must be a JSON object;
 * what its fields mean is the caller's to check.
 */
export async function openSignedToken(
  subtle: Pick<HmacPort, 'verify'>,
  key: CryptoKey,
  version: string,
  token: string,
): Promise<SignedTokenOpening> {
  const parts = token.split('.');
  const [tag, payloadPart, signaturePart] = parts;
  if (parts.length !== 3 || payloadPart === undefined || signaturePart === undefined) {
    return refused({ kind: 'parts-count', count: parts.length });
  }
  if (tag !== version) return refused({ kind: 'version' });

  const signature = decodeBase64Url(signaturePart);
  if (signature === null) return refused({ kind: 'signature-encoding' });
  // Constant-time, and before anything attacker-controlled is parsed.
  const verified = await subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(`${tag}.${payloadPart}`),
  );
  if (!verified) return refused({ kind: 'signature' });

  const payloadBytes = decodeBase64Url(payloadPart);
  if (payloadBytes === null) return refused({ kind: 'payload-encoding' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return refused({ kind: 'payload-json' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refused({ kind: 'payload-not-object' });
  }
  // A non-null, non-array object straight from `JSON.parse`: its keys are strings, its values unknown.
  return { ok: true, payload: parsed as Readonly<Record<string, unknown>> };
}
