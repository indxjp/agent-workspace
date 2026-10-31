import { describe, expect, it } from 'vitest';

import { loadOutboundProxyFromEnv, outboundProxyFor } from './outbound-proxy.js';

const PROXY = 'http://proxy.internal:3128';

describe('loadOutboundProxyFromEnv', () => {
  it('reads HTTPS_PROXY, HTTP_PROXY and NO_PROXY, upper case first', () => {
    expect(
      loadOutboundProxyFromEnv({
        HTTPS_PROXY: PROXY,
        https_proxy: 'http://ignored:1',
        http_proxy: 'http://plain.internal:8080',
        NO_PROXY: ' .internal.example , localhost,,127.0.0.1 ',
      }),
    ).toEqual({
      httpsProxy: PROXY,
      httpProxy: 'http://plain.internal:8080',
      noProxy: ['.internal.example', 'localhost', '127.0.0.1'],
    });
  });

  it('is empty when nothing is set, or set to blank', () => {
    expect(loadOutboundProxyFromEnv({})).toEqual({
      httpsProxy: null,
      httpProxy: null,
      noProxy: [],
    });
    expect(loadOutboundProxyFromEnv({ HTTPS_PROXY: '  ', no_proxy: '' })).toEqual({
      httpsProxy: null,
      httpProxy: null,
      noProxy: [],
    });
  });

  it.each(['proxy.internal:3128', 'socks5://proxy.internal:1080', 'http://'])(
    'refuses a proxy that is not an http(s) URL, without echoing it: %s',
    (value) => {
      expect(() => loadOutboundProxyFromEnv({ HTTPS_PROXY: value })).toThrow(
        'HTTPS_PROXY must be an http: or https: URL.',
      );
      try {
        loadOutboundProxyFromEnv({ HTTPS_PROXY: value });
      } catch (error) {
        expect(String(error)).not.toContain(value);
      }
    },
  );
});

describe('outboundProxyFor', () => {
  const config = loadOutboundProxyFromEnv({
    HTTPS_PROXY: PROXY,
    NO_PROXY: '.corp.example,storage.example:8443,10.1.2.3,[fd00::5],Direct.Example',
  });
  const proxyOf = (target: string) => outboundProxyFor(new URL(target), config);

  it('sends an https target through HTTPS_PROXY, and an http target only through HTTP_PROXY', () => {
    expect(proxyOf('https://acme.blob.core.windows.net')).toBe(PROXY);
    expect(proxyOf('http://acme.example')).toBeNull();
    const both = loadOutboundProxyFromEnv({ HTTP_PROXY: 'http://plain:8080' });
    expect(outboundProxyFor(new URL('http://acme.example'), both)).toBe('http://plain:8080');
    expect(outboundProxyFor(new URL('https://acme.example'), both)).toBeNull();
  });

  it.each([
    ['https://corp.example', null],
    ['https://a.b.corp.example', null],
    ['https://notcorp.example', PROXY],
    ['https://storage.example:8443', null],
    ['https://storage.example', PROXY],
    ['https://10.1.2.3', null],
    ['https://[fd00::5]', null],
    ['https://direct.example', null],
    ['https://sub.direct.example', null],
    ['https://indirect.example', PROXY],
  ])('NO_PROXY decides %s', (target, expected) => {
    expect(proxyOf(target)).toBe(expected);
  });

  it('NO_PROXY=* turns the proxy off for every target', () => {
    const off = loadOutboundProxyFromEnv({ HTTPS_PROXY: PROXY, NO_PROXY: '*' });
    expect(outboundProxyFor(new URL('https://anything.example'), off)).toBeNull();
  });
});
