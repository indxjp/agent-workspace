import { describe, expect, it } from 'vitest';

import { CONNECTOR_TRANSPORTS } from '@indx-workspace/contracts/connectors';

import { credentialFieldFor, credentialHeaderValue, parseCreateConnectorBody } from './contract';

describe('credentialFieldFor', () => {
  it('is null for authType none, on every transport', () => {
    for (const transport of CONNECTOR_TRANSPORTS) {
      expect(credentialFieldFor(transport, 'none')).toBeNull();
    }
  });

  it('is an env var for stdio, for every authenticated type', () => {
    for (const authType of ['api-key', 'bearer', 'oauth'] as const) {
      expect(credentialFieldFor('stdio', authType)).toEqual({
        kind: 'env',
        name: 'MCP_CREDENTIAL',
      });
    }
  });

  it('is the Authorization header for bearer and oauth, on http and sse', () => {
    for (const transport of ['http', 'sse'] as const) {
      expect(credentialFieldFor(transport, 'bearer')).toEqual({
        kind: 'header',
        name: 'Authorization',
      });
      expect(credentialFieldFor(transport, 'oauth')).toEqual({
        kind: 'header',
        name: 'Authorization',
      });
    }
  });

  it('is X-Api-Key for api-key, on http and sse', () => {
    expect(credentialFieldFor('http', 'api-key')).toEqual({ kind: 'header', name: 'X-Api-Key' });
    expect(credentialFieldFor('sse', 'api-key')).toEqual({ kind: 'header', name: 'X-Api-Key' });
  });
});

describe('credentialHeaderValue', () => {
  it('prefixes bearer and oauth with "Bearer "', () => {
    expect(credentialHeaderValue('bearer', 'tok')).toBe('Bearer tok');
    expect(credentialHeaderValue('oauth', 'tok')).toBe('Bearer tok');
  });
  it('leaves an api-key value verbatim', () => {
    expect(credentialHeaderValue('api-key', 'tok')).toBe('tok');
  });
});

describe('parseCreateConnectorBody', () => {
  it('accepts a minimal stdio connector with no credential', () => {
    const result = parseCreateConnectorBody({
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        name: 'Filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        url: null,
        authType: 'none',
        credential: null,
      });
    }
  });

  it('accepts a minimal http connector with a bearer credential', () => {
    const result = parseCreateConnectorBody({
      name: 'GitHub',
      transport: 'http',
      url: 'https://api.example.test/mcp',
      authType: 'bearer',
      credential: 'sk-ant-secret',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.command).toBeNull();
      expect(result.value.args).toBeNull();
      expect(result.value.credential).toBe('sk-ant-secret');
    }
  });

  it('rejects a body that is not an object', () => {
    expect(parseCreateConnectorBody('nope').ok).toBe(false);
    expect(parseCreateConnectorBody(null).ok).toBe(false);
    expect(parseCreateConnectorBody([1, 2]).ok).toBe(false);
  });

  it('rejects an unknown transport', () => {
    const result = parseCreateConnectorBody({ name: 'X', transport: 'ftp' });
    expect(result.ok).toBe(false);
  });

  it('rejects stdio with no command', () => {
    const result = parseCreateConnectorBody({ name: 'X', transport: 'stdio' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('command'))).toBe(true);
  });

  it('rejects stdio carrying a url', () => {
    const result = parseCreateConnectorBody({
      name: 'X',
      transport: 'stdio',
      command: 'true',
      url: 'https://example.test',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects http with no url', () => {
    const result = parseCreateConnectorBody({ name: 'X', transport: 'http' });
    expect(result.ok).toBe(false);
  });

  it('rejects http with a non-absolute url', () => {
    const result = parseCreateConnectorBody({ name: 'X', transport: 'http', url: '/relative' });
    expect(result.ok).toBe(false);
  });

  it.each([
    'https://',
    'HTTPS://e.test/mcp',
    'https://user:pw@e.test/mcp',
    'https://e.test/mcp?token=t',
  ])('rejects http with a host-less or credential-bearing url %s', (url) => {
    expect(parseCreateConnectorBody({ name: 'X', transport: 'http', url }).ok).toBe(false);
  });

  it('rejects http carrying command or args', () => {
    expect(
      parseCreateConnectorBody({
        name: 'X',
        transport: 'http',
        url: 'https://e.test',
        command: 'no',
      }).ok,
    ).toBe(false);
    expect(
      parseCreateConnectorBody({
        name: 'X',
        transport: 'http',
        url: 'https://e.test',
        args: ['no'],
      }).ok,
    ).toBe(false);
  });

  it('rejects an authenticated type with no credential', () => {
    const result = parseCreateConnectorBody({
      name: 'X',
      transport: 'http',
      url: 'https://e.test',
      authType: 'bearer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('credential'))).toBe(true);
  });

  it('rejects a credential supplied alongside authType none', () => {
    const result = parseCreateConnectorBody({
      name: 'X',
      transport: 'stdio',
      command: 'true',
      authType: 'none',
      credential: 'should-not-be-here',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects args that are not all strings', () => {
    const result = parseCreateConnectorBody({
      name: 'X',
      transport: 'stdio',
      command: 'true',
      args: ['ok', 5],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an empty name', () => {
    const result = parseCreateConnectorBody({ name: '', transport: 'stdio', command: 'true' });
    expect(result.ok).toBe(false);
  });
});
