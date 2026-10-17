import { describe, expect, it } from 'vitest';

import { endpointCredentialKey, readCappedBody } from './request';

const principal = { principalId: 'principal-1' };

describe('endpointCredentialKey', () => {
  it('keys an OAuth grant by its client, an API key by its id, anything else by the principal', () => {
    expect(endpointCredentialKey({ principal, apiKeyId: 'key-1', oauth: { clientId: 'c1' } })).toBe(
      'oauth:c1',
    );
    expect(endpointCredentialKey({ principal, apiKeyId: 'key-1', oauth: null })).toBe('key-1');
    expect(endpointCredentialKey({ principal, apiKeyId: null, oauth: null })).toBe(
      principal.principalId,
    );
  });
});

const post = (body: BodyInit | null): Request => new Request('http://x/', { method: 'POST', body });

describe('readCappedBody', () => {
  it('reads a body within the cap, and an absent body as empty', async () => {
    expect(await readCappedBody(post('héllo'), 16)).toEqual({ kind: 'ok', text: 'héllo' });
    expect(await readCappedBody(new Request('http://x/'), 16)).toEqual({ kind: 'ok', text: '' });
  });

  it('refuses a body over the cap by the bytes read, not the header', async () => {
    const request = new Request('http://x/', {
      method: 'POST',
      headers: { 'content-length': '1' },
      body: 'x'.repeat(17),
    });
    expect(await readCappedBody(request, 16)).toEqual({ kind: 'too_large' });
    expect(await readCappedBody(post('x'.repeat(16)), 16)).toMatchObject({ kind: 'ok' });
  });

  it('reports a stream that fails as unreadable', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull: () => {
        throw new Error('reset');
      },
    });
    const request = new Request('http://x/', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(await readCappedBody(request, 16)).toEqual({ kind: 'unreadable' });
  });
});
