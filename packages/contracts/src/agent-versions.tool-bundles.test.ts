import { describe, expect, it } from 'vitest';
import {
  AGENT_VERSION_PROBLEM_CODES,
  AgentVersionToolBundleSchema,
  ToolSecretNamesSchema,
  ToolSandboxManifestSchema,
  ToolSandboxRequestSchema,
  TOOL_BUNDLE_MAX_BYTES,
  TOOL_BUNDLE_PROBLEM_CODES,
  ToolBundleDigestSchema,
  UploadToolBundleRequestSchema,
  UploadToolBundleResponseSchema,
} from './agent-versions.js';
import { DIGEST } from './agent-versions.test-support.js';

describe('tool bundles (#790): declarations', () => {
  it('records the declaration a hosted tool sandbox serves, and keeps an old entry valid (#791)', () => {
    const declared = {
      tool: 'lookup',
      digest: DIGEST,
      description: 'Look up an order',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      timeoutMs: 5000,
      secrets: ['ORDERS_API_KEY'],
      allowedDomains: ['api.example.com', '*.example.org'],
    };
    expect(AgentVersionToolBundleSchema.parse(declared)).toEqual(declared);
    expect(AgentVersionToolBundleSchema.parse({ tool: 'lookup', digest: DIGEST })).toEqual({
      tool: 'lookup',
      digest: DIGEST,
    });
  });

  it.each([
    ['a secret value', { secrets: ['sk-live-123'] }],
    ['a reserved secret name', { secrets: ['PORT'] }],
    ['a repeated secret', { secrets: ['A_KEY', 'A_KEY'] }],
    ['a bare * domain', { allowedDomains: ['*'] }],
    ['a domain with a comma', { allowedDomains: ['a.com,b.com'] }],
    ['a repeated domain', { allowedDomains: ['a.com', 'a.com'] }],
    ['a zero timeout', { timeoutMs: 0 }],
    ['an unknown key', { env: 'x' }],
  ])('refuses %s in a bundle entry (#791)', (_label, change) => {
    expect(
      AgentVersionToolBundleSchema.safeParse({ tool: 'lookup', digest: DIGEST, ...change }).success,
    ).toBe(false);
  });

  it("[#2283][unit][sdk] refuses a model or runtime connection's credential among a code tool's secrets", () => {
    for (const name of [
      'MODEL_CONNECTION_77777777777747778777777777777777',
      'RUNTIME_CONNECTION__DOCKER__DOCKER_DEFAULT',
      'WEBHOOK_77777777777747778777777777777777_SIGNING_SECRET',
    ]) {
      expect(ToolSecretNamesSchema.safeParse([name]).success, name).toBe(false);
    }
    expect(ToolSecretNamesSchema.safeParse(['WEBHOOK_STRIPE_SIGNING_SECRET']).success).toBe(true);
  });

  // @story US-STO-12
});

describe('tool bundles (#790): storage credentials', () => {
  it("[US-STO-12][unit][sdk] refuses a storage connection credential among a code tool's secrets", () => {
    for (const name of [
      'STORAGE_CONNECTION_77777777777747778777777777777777',
      'STORAGE_CONNECTION_ANYTHING',
    ]) {
      const refused = ToolSecretNamesSchema.safeParse([name]);
      expect(refused.success, name).toBe(false);
      expect(
        refused.error?.issues.map((issue) => issue.message),
        name,
      ).toContain(
        'must not name a platform-owned credential (STORAGE_CONNECTION_, MODEL_CONNECTION_, RUNTIME_CONNECTION__ or a webhook signing secret)',
      );
      expect(
        AgentVersionToolBundleSchema.safeParse({ tool: 'lookup', digest: DIGEST, secrets: [name] })
          .success,
        name,
      ).toBe(false);
    }
    expect(ToolSecretNamesSchema.safeParse(['STORAGE_KEY', 'CONNECTION_TOKEN']).success).toBe(true);
  });
});

describe('tool bundles (#790): digests and uploads', () => {
  it('accepts exactly a 64-character lower-case hex digest', () => {
    expect(ToolBundleDigestSchema.safeParse(DIGEST).success).toBe(true);
    expect(ToolBundleDigestSchema.safeParse(DIGEST.slice(1)).success).toBe(false);
    expect(ToolBundleDigestSchema.safeParse(`${DIGEST}0`).success).toBe(false);
    expect(ToolBundleDigestSchema.safeParse('g'.repeat(64)).success).toBe(false);
  });

  it('parses an upload as strict, padded, non-empty base64 within the byte ceiling', () => {
    expect(UploadToolBundleRequestSchema.safeParse({ contentBase64: 'aGk=' }).success).toBe(true);
    expect(UploadToolBundleRequestSchema.safeParse({ contentBase64: '' }).success).toBe(false);
    expect(UploadToolBundleRequestSchema.safeParse({ contentBase64: 'aGk' }).success).toBe(false);
    expect(UploadToolBundleRequestSchema.safeParse({ contentBase64: 'aGk=', x: 1 }).success).toBe(
      false,
    );
    const oversize = 'A'.repeat(Math.ceil(TOOL_BUNDLE_MAX_BYTES / 3) * 4 + 4);
    expect(UploadToolBundleRequestSchema.safeParse({ contentBase64: oversize }).success).toBe(
      false,
    );
  });

  it('parses the upload answer and refuses a non-positive size', () => {
    const bundle = { digest: DIGEST, sizeBytes: 12 };
    expect(UploadToolBundleResponseSchema.parse({ bundle, created: true })).toEqual({
      bundle,
      created: true,
    });
    expect(
      UploadToolBundleResponseSchema.safeParse({
        bundle: { ...bundle, sizeBytes: 0 },
        created: true,
      }).success,
    ).toBe(false);
  });

  it('maps its problem codes and shares the not-configured status with versions', () => {
    expect(TOOL_BUNDLE_PROBLEM_CODES).toEqual({
      invalid_tool_bundle: 400,
      tool_bundle_too_large: 413,
      tool_bundle_not_found: 404,
      tool_bundles_not_configured: 503,
    });
    expect(AGENT_VERSION_PROBLEM_CODES.tool_bundles_not_configured).toBe(
      TOOL_BUNDLE_PROBLEM_CODES.tool_bundles_not_configured,
    );
  });
});

describe('ToolSandboxRequestSchema', () => {
  const digest = 'a'.repeat(64);
  const request = {
    key: 'tools-1',
    manifest: {
      tools: [
        {
          name: 'get_order',
          description: 'Looks up an order.',
          inputSchema: { type: 'object' },
          timeoutMs: 5_000,
          digest,
          bundleBase64: btoa('export default () => 1;'),
        },
      ],
      env: { ORDERS_API_KEY: 'sk-live' },
    },
    allowedDomains: ['api.example.com'],
    run: { runId: 'run_1', token: 'a-run-token-0123456789' },
  };

  it('accepts a session tool set with its secrets, domains and run token', () => {
    expect(ToolSandboxRequestSchema.safeParse(request).success).toBe(true);
  });

  it.each([
    ['no tools', { ...request, manifest: { ...request.manifest, tools: [] } }],
    [
      'an environment name that is not a secret name',
      { ...request, manifest: { ...request.manifest, env: { 'not a name': 'x' } } },
    ],
    [
      'a bundle that is not base64',
      {
        ...request,
        manifest: {
          ...request.manifest,
          tools: [{ ...request.manifest.tools[0], bundleBase64: 'not base64!' }],
        },
      },
    ],
    ['a short token', { ...request, run: { runId: 'run_1', token: 'short' } }],
    ['an unknown key', { ...request, extra: true }],
  ])('refuses %s', (_name, value) => {
    expect(ToolSandboxRequestSchema.safeParse(value).success).toBe(false);
  });
});

describe('ToolSandboxManifestSchema stdio servers', () => {
  const server = {
    name: 'fixture',
    command: 'npx',
    args: ['-y', '@scope/pkg@1.2.3'],
    timeoutMs: 30_000,
  };
  const manifest = { tools: [], stdioServers: [server], env: {} };
  const parse = (value: unknown) => ToolSandboxManifestSchema.safeParse(value);

  it('accepts a pinned npx server with no tools, and a tools-only manifest', () => {
    expect(parse(manifest).success).toBe(true);
    expect(
      parse({ ...manifest, stdioServers: [{ ...server, args: ['pkg@1.0.0-rc.1', '--x'] }] })
        .success,
    ).toBe(true);
    const tools = [
      {
        name: 'get_order',
        description: 'Looks up an order.',
        inputSchema: { type: 'object' },
        timeoutMs: 5_000,
        digest: 'a'.repeat(64),
        bundleBase64: btoa('export default () => 1;'),
      },
    ];
    const parsed = parse({ tools, env: {} });
    expect(parsed.success && parsed.data.stdioServers).toEqual([]);
  });

  it.each([
    ['an unpinned package', ['pkg']],
    ['a range', ['pkg@^1.2.3']],
    ['a tag', ['-y', 'pkg@latest']],
    ['a partial version', ['pkg@1.2']],
    ['no package', ['-y']],
    ['a flag in the package position', ['--yes', 'pkg@1.2.3']],
    ['a url', ['https://example.com/pkg.tgz@1.2.3']],
  ])('refuses %s and names the field, not the value', (_name, args) => {
    const refused = parse({ ...manifest, stdioServers: [{ ...server, args }] });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'stdioServers.0.args',
    ]);
  });

  it.each([
    ['a command that is not npx', { ...manifest, stdioServers: [{ ...server, command: 'node' }] }],
    [
      'a server name that is not a path segment',
      { ...manifest, stdioServers: [{ ...server, name: 'a/b' }] },
    ],
    ['duplicate server names', { ...manifest, stdioServers: [server, server] }],
    ['nothing to serve', { tools: [], stdioServers: [], env: {} }],
    ['an unknown key on a server', { ...manifest, stdioServers: [{ ...server, env: {} }] }],
  ])('refuses %s', (_name, value) => {
    expect(parse(value).success).toBe(false);
  });
});
