import { z } from 'zod';

import { SecretNameSchema } from '../secret-reference.js';
import { ToolOperationNameSchema } from '../tool-connectors.js';
import {
  TOOL_BUNDLE_BASE64_PATTERN,
  TOOL_BUNDLE_MAX_BASE64_LENGTH,
  TOOL_BUNDLE_TIMEOUT_MAX_MS,
  ToolAllowedDomainsSchema,
  ToolBundleDigestSchema,
} from './tool-bundles.js';

/** One tool of a session's sandbox: what the tool host serves, and the bundle it runs. */
export const ToolSandboxToolSchema = z
  .object({
    name: ToolOperationNameSchema,
    description: z.string().min(1).max(2048),
    inputSchema: z.record(z.string(), z.unknown()).readonly(),
    timeoutMs: z.number().int().min(1).max(TOOL_BUNDLE_TIMEOUT_MAX_MS),
    digest: ToolBundleDigestSchema,
    bundleBase64: z
      .string()
      .min(1)
      .max(TOOL_BUNDLE_MAX_BASE64_LENGTH)
      .regex(TOOL_BUNDLE_BASE64_PATTERN, 'must be standard padded base64'),
  })
  .strict()
  .readonly();

/** The most tools one session's tool sandbox serves. */
export const TOOL_SANDBOX_TOOLS_MAX = 64;

const NPM_PACKAGE_NAME = String.raw`(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*`;
const EXACT_SEMVER = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
/** `<package>@<exact version>`: a range, a tag or `latest` is not a pin. */
const PINNED_NPM_PACKAGE = new RegExp(`^${NPM_PACKAGE_NAME}@${EXACT_SEMVER}$`, 'u');

/**
 * One `stdio` MCP server of a session's sandbox (ADR-0118 TS6): launched once, behind the same
 * front as the tools, at `/stdio/<name>/mcp`. The command is pinned: `npx`, then optionally `-y`,
 * then `<package>@<exact version>`, then the server's own arguments. A secret never travels in
 * `args`; the server gets the sandbox's environment (TS4).
 */
const ToolSandboxStdioServerSchema = z
  .object({
    name: ToolOperationNameSchema,
    command: z.literal('npx'),
    args: z.array(z.string().max(1024)).min(1).max(64).readonly(),
    timeoutMs: z.number().int().min(1).max(TOOL_BUNDLE_TIMEOUT_MAX_MS),
  })
  .strict()
  .readonly()
  .superRefine((server, context) => {
    const [first, second] = server.args;
    const pinned = first === '-y' ? second : first;
    if (pinned === undefined || !PINNED_NPM_PACKAGE.test(pinned)) {
      context.addIssue({
        code: 'custom',
        path: ['args'],
        message: 'must name a package pinned to an exact version: [-y] <package>@<x.y.z>',
      });
    }
  });

/**
 * What the runner hands a tool sandbox (ADR-0118 TS2, TS4, TS6): the tools and `stdio` servers to
 * serve and `env`, which is the sandbox's whole environment, exactly the secrets the session's
 * tools and servers declared. It is written into the sandbox as a file, never passed as an
 * argument or an image environment variable.
 */
export const ToolSandboxManifestSchema = z
  .object({
    tools: z.array(ToolSandboxToolSchema).max(TOOL_SANDBOX_TOOLS_MAX).readonly(),
    stdioServers: z
      .array(ToolSandboxStdioServerSchema)
      .max(TOOL_SANDBOX_TOOLS_MAX)
      .readonly()
      .default([]),
    env: z.record(SecretNameSchema, z.string().max(65_536)).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((manifest, context) => {
    if (manifest.tools.length + manifest.stdioServers.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['tools'],
        message: 'must serve a tool or a server',
      });
    }
    const seen = new Set<string>();
    manifest.stdioServers.forEach((server, index) => {
      if (seen.has(server.name)) {
        context.addIssue({
          code: 'custom',
          path: ['stdioServers', index, 'name'],
          message: 'must be unique',
        });
      }
      seen.add(server.name);
    });
  });
export type ToolSandboxManifest = z.infer<typeof ToolSandboxManifestSchema>;

/**
 * What a run request tells the runner about its session's tool sandbox (ADR-0118 TS2, TS3, TS4,
 * TS5): `key` identifies the session's tool set (a changed key replaces the sandbox), `manifest` is
 * what to serve, `allowedDomains` the union the sandbox may reach, and `run` the run and the
 * per-run bearer token the gateway will present for it.
 */
export const ToolSandboxRequestSchema = z
  .object({
    key: z.string().min(1).max(128),
    manifest: ToolSandboxManifestSchema,
    allowedDomains: ToolAllowedDomainsSchema,
    run: z
      .object({ runId: z.string().min(1).max(128), token: z.string().min(16).max(256) })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
export type ToolSandboxRequest = z.infer<typeof ToolSandboxRequestSchema>;
