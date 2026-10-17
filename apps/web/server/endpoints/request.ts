/** What the public agent endpoints (A2A, project tools) share when they read a request. */

/** The rate-limit key of a credential: the OAuth client, else the API key's id (not a secret). */
export function endpointCredentialKey(identity: {
  readonly principal: { readonly principalId: string };
  readonly apiKeyId: string | null;
  readonly oauth: { readonly clientId: string } | null;
}): string {
  return identity.oauth === null
    ? (identity.apiKeyId ?? identity.principal.principalId)
    : `oauth:${identity.oauth.clientId}`;
}

export type CappedBody =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'unreadable' };

/** Read at most `max` bytes, counting the bytes seen rather than trusting `Content-Length`. */
export async function readCappedBody(request: Request, max: number): Promise<CappedBody> {
  if (request.body === null) return { kind: 'ok', text: '' };
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        return { kind: 'too_large' };
      }
      text += decoder.decode(value, { stream: true });
    }
    return { kind: 'ok', text: text + decoder.decode() };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    reader.releaseLock();
  }
}
