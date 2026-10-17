import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { PublicMessageForm, sendPublicMessage } from './public-message-form';

describe('public message form', () => {
  it('renders the public message control without a result before submission', () => {
    const html = renderToStaticMarkup(createElement(PublicMessageForm, { token: 'pub_test' }));

    expect(html).toContain('Send a message');
    expect(html).toContain('<input');
    expect(html).toContain('<button');
    expect(html).not.toContain('<pre');
  });

  it('posts the prompt to the encoded public-share path and renders successful JSON', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output: 'Hello' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(sendPublicMessage('pub/slash', { prompt: 'Hello there' }, request)).resolves.toBe(
      JSON.stringify({ output: 'Hello' }),
    );
    expect(request).toHaveBeenCalledWith('/p/pub%2Fslash/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Hello there' }),
    });
  });

  it('sends the passphrase of a protected share in the POST body, never in the URL', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ accepted: true }, { status: 202 }));

    await sendPublicMessage('pub_test', { prompt: 'Hi', passphrase: 'open sesame' }, request);

    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/p/pub_test/messages');
    expect(JSON.parse(init.body as string)).toEqual({ prompt: 'Hi', passphrase: 'open sesame' });
  });

  it('shows an HTTP refusal without trusting or parsing its response body', async () => {
    const response = new Response('not JSON', { status: 429 });
    const json = vi.spyOn(response, 'json');

    await expect(
      sendPublicMessage('pub_test', { prompt: 'Retry me' }, () => Promise.resolve(response)),
    ).resolves.toBe('Message refused (429)');
    expect(json).not.toHaveBeenCalled();
  });

  it('turns network and malformed-success failures into stable user feedback', async () => {
    await expect(
      sendPublicMessage('pub_test', { prompt: 'Hello' }, () =>
        Promise.reject(new Error('socket details')),
      ),
    ).resolves.toBe('Message could not be sent.');
    await expect(
      sendPublicMessage('pub_test', { prompt: 'Hello' }, () =>
        Promise.resolve(new Response('not JSON', { status: 202 })),
      ),
    ).resolves.toBe('Message could not be sent.');
  });
});
