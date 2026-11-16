import type { ToolSandboxOptions, SandboxAllocation } from './tool-sandbox-contracts.js';

export type SandboxContext = {
  options: ToolSandboxOptions;
  doFetch: typeof globalThis.fetch;
  readyTimeoutMs: number;
  sandboxes: Map<string, SandboxAllocation>;
  queue: Map<string, Promise<unknown>>;
  upstreamOf: ToolSandboxOptions['upstream'];
  servingWhen: (status: number) => boolean;
  lastStatus: number | undefined;
};

export function createSandboxContext(options: ToolSandboxOptions): SandboxContext {
  const upstreamOf = options.upstream;
  return {
    options,
    doFetch: options.fetch ?? globalThis.fetch,
    readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
    sandboxes: new Map(),
    queue: new Map(),
    upstreamOf,
    servingWhen: options.servingWhen ?? ((status) => upstreamOf === undefined || status < 500),
    lastStatus: undefined,
  };
}
