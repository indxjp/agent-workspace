import { describe, expect, it } from 'vitest';

import { withToolHostRunHeaders } from './run-request';

export function registerToolSandboxHeadersTests() {
  describe('withToolHostRunHeaders with a tool sandbox', () => {
    it('replaces only the tool host connector’s entry', () => {
      const servers = withToolHostRunHeaders(
        {
          files: [],
          skills: [],
          mcpServers: {
            host: { type: 'http', url: 'https://tool-sandbox.invalid/mcp', headers: { a: 'b' } },
            other: { type: 'http', url: 'https://mcp.example' },
          },
          connectorNames: { host: 'aw-dev-tools', other: 'github' },
        },
        'run-1',
        'サポート',
        { url: 'http://gateway:4000/v1/tool-sandbox/mcp', token: 'tok' },
      );
      expect(servers['host']).toEqual({
        type: 'http',
        url: 'http://gateway:4000/v1/tool-sandbox/mcp',
        headers: { authorization: 'Bearer tok', 'x-aw-agent': encodeURIComponent('サポート') },
      });
      expect(servers['other']).toEqual({ type: 'http', url: 'https://mcp.example' });
    });
  });
}
