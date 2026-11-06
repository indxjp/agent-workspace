import { describe, expect, it } from 'vitest';

import { withToolHostRunHeaders } from './run-request';

export function registerToolHostHeadersTests() {
  describe('withToolHostRunHeaders (ADR-0115)', () => {
    it('tells only the tool host connector which run and agent call it', () => {
      const servers = withToolHostRunHeaders(
        {
          files: [],
          skills: [],
          mcpServers: {
            host: { type: 'http', url: 'http://127.0.0.1:9/token/mcp', headers: { a: 'b' } },
            other: { type: 'http', url: 'https://mcp.example' },
          },
          connectorNames: { host: 'aw-dev-tools', other: 'github' },
        },
        'run-1',
        'サポート',
      );
      const host = servers['host'];
      // A header value is a ByteString: the Unicode name travels percent-encoded.
      expect(() => new Headers(host && 'headers' in host ? host.headers : {})).not.toThrow();
      expect(host).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:9/token/mcp',
        headers: { a: 'b', 'x-aw-run-id': 'run-1', 'x-aw-agent': encodeURIComponent('サポート') },
      });
      expect(servers['other']).toEqual({ type: 'http', url: 'https://mcp.example' });
    });
  });
}
