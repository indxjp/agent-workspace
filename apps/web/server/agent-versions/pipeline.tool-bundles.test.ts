import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_VERSION_PROBLEM_CODES,
  AgentVersionBodySchema,
} from '@indx-workspace/contracts/agent-versions';

import { clearEnginesRegisteredForTests } from '../engines/registry';
import type { ToolBundleLookup } from '../tool-bundles/handlers';
import { versionRequest } from './fixtures';
import { validateAgentVersion } from './pipeline';
import {
  agent,
  expectRefusal,
  refusalOf,
  storeWith,
  validate,
  withBody,
} from './pipeline.test-support';

afterEach(() => {
  clearEnginesRegisteredForTests();
});

describe('pinned tool bundles (issue #790)', () => {
  const STORED = 'a'.repeat(64);
  const UNKNOWN = 'b'.repeat(64);

  function pinning(...digests: string[]) {
    return withBody(versionRequest(), {
      toolBundles: digests.map((digest, index) => ({ tool: `tool_${String(index)}`, digest })),
    });
  }

  const lookup = (digests: readonly string[]): Promise<readonly string[]> =>
    Promise.resolve(digests.filter((digest) => digest !== STORED));

  function validatePinning(raw: unknown, toolBundles: ToolBundleLookup | null) {
    return validate(raw, { toolBundles });
  }

  it('accepts a body whose every digest is stored', async () => {
    expect((await validatePinning(pinning(STORED), lookup)).ok).toBe(true);
  });

  it('refuses an unknown digest with 422 tool_bundle_unknown naming it', async () => {
    expectRefusal(
      await validatePinning(pinning(STORED, UNKNOWN), lookup),
      AGENT_VERSION_PROBLEM_CODES.tool_bundle_unknown,
      'tool_bundle_unknown',
      [`tool_bundle:${UNKNOWN}`],
    );
  });

  it('refuses the same way for a dry run', async () => {
    const dryRun = { ...pinning(UNKNOWN), dryRun: true };
    const refusal = refusalOf(await validatePinning(dryRun, lookup));
    expect(refusal.body).toMatchObject({ error: { code: 'tool_bundle_unknown' } });
  });

  it('answers 503 when the body pins bundles and the deployment keeps none', async () => {
    expectRefusal(
      await validatePinning(pinning(STORED), null),
      AGENT_VERSION_PROBLEM_CODES.tool_bundles_not_configured,
      'tool_bundles_not_configured',
    );
  });

  it('refuses a pinned body by name on a deployment without a tool sandbox, before resolution', async () => {
    for (const dryRun of [{ dryRun: true }, {}]) {
      const result = await validate(
        { ...pinning(STORED), ...dryRun },
        { toolBundles: lookup, toolHost: false },
      );
      expectRefusal(result, 422, 'code_tool_needs_host', ['connector:aw-dev-tools', 'tool:tool_0']);
    }
    const unpinned = await validate(versionRequest(), { toolHost: false });
    expect(unpinned.ok).toBe(true);
  });

  it('accepts the same pinned body once the deployment has a tool host (E2B, #827), dry run or not', async () => {
    for (const dryRun of [{ dryRun: true }, {}]) {
      const result = await validate(
        { ...pinning(STORED), ...dryRun },
        { toolBundles: lookup, toolHost: true },
      );
      expect(result.ok).toBe(true);
    }
  });

  describe('a tool sandbox that cannot enforce allowedDomains (#1018)', () => {
    const REASON = 'cannot enforce restricted yet';

    function withTools(tools: readonly { tool: string; allowedDomains?: string[] }[]) {
      return withBody(versionRequest(), {
        toolBundles: tools.map((entry) => ({ ...entry, digest: STORED })),
      });
    }

    function validateWith(
      raw: unknown,
      context: { toolHost?: boolean; toolDomainsRefusal?: string | null },
    ) {
      return validate(raw, { toolBundles: lookup, ...context });
    }

    it('refuses a domain-declaring tool by name with 422 network_policy_unsupported, before resolution', async () => {
      const store = await storeWith();
      const resolveDefinition = vi.spyOn(store, 'resolveDefinition');
      const result = await validate(
        withTools([{ tool: 'fetch_order', allowedDomains: ['api.example.com'] }]),
        { store, toolBundles: lookup, toolHost: true, toolDomainsRefusal: REASON },
      );
      const refusal = refusalOf(result);
      expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.network_policy_unsupported);
      expect(refusal.body).toMatchObject({
        error: { code: 'network_policy_unsupported', details: ['tool:fetch_order'] },
      });
      expect(JSON.stringify(refusal.body)).toContain(REASON);
      expect(resolveDefinition).not.toHaveBeenCalled();
    });

    it('names only the tools that declare domains', async () => {
      const result = await validateWith(
        withTools([
          { tool: 'offline' },
          { tool: 'fetch_order', allowedDomains: ['api.example.com'] },
          { tool: 'empty', allowedDomains: [] },
          { tool: 'fetch_user', allowedDomains: ['*.example.com'] },
        ]),
        { toolHost: true, toolDomainsRefusal: REASON },
      );
      expect(refusalOf(result).body).toMatchObject({
        error: { details: ['tool:fetch_order', 'tool:fetch_user'] },
      });
    });

    it('accepts tools that declare no network, so they still push and run on E2B', async () => {
      const result = await validateWith(
        withTools([{ tool: 'offline' }, { tool: 'empty', allowedDomains: [] }]),
        {
          toolHost: true,
          toolDomainsRefusal: REASON,
        },
      );
      expect(result.ok).toBe(true);
    });

    it('accepts a domain-declaring tool where the sandbox enforces them (docker with the proxy)', async () => {
      const result = await validateWith(
        withTools([{ tool: 'fetch_order', allowedDomains: ['api.example.com'] }]),
        { toolHost: true, toolDomainsRefusal: null },
      );
      expect(result.ok).toBe(true);
    });

    it('does not check when no capability is given (a caller that does not thread it)', async () => {
      const result = await validateWith(
        withTools([{ tool: 'fetch_order', allowedDomains: ['api.example.com'] }]),
        { toolHost: true },
      );
      expect(result.ok).toBe(true);
    });

    it('still answers code_tool_needs_host first on a deployment without a tool sandbox', async () => {
      const result = await validateWith(
        withTools([{ tool: 'fetch_order', allowedDomains: ['api.example.com'] }]),
        { toolHost: false, toolDomainsRefusal: REASON },
      );
      expect(refusalOf(result).body).toMatchObject({ error: { code: 'code_tool_needs_host' } });
    });
  });

  it('never asks the store when the body pins nothing', async () => {
    const asked: string[] = [];
    const result = await validatePinning(versionRequest(), (digests) => {
      asked.push(...digests);
      return Promise.resolve([]);
    });
    expect(result.ok).toBe(true);
    expect(asked).toEqual([]);
  });

  it('checks a stored body at a pointer move too', async () => {
    const body = AgentVersionBodySchema.parse(pinning(UNKNOWN).body);
    const result = await validateAgentVersion(body, {
      store: await storeWith(),
      subject: { kind: 'existing', agent: agent() },
      bodyPath: 'body',
      dryRun: false,
      toolBundles: lookup,
    });
    expect(refusalOf(result).body).toMatchObject({ error: { code: 'tool_bundle_unknown' } });
  });
});
