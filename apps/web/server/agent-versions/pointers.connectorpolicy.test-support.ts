import { expect, it } from 'vitest';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';
import { promoteAgent, rollbackAgent, setAgentPointer } from './pointers';
import { ACTOR, agentWithVersions, barOf, harness, point } from './pointers.test-support';

export function registerPointerConnectorPolicyTests() {
  it('refuses a version with code tools for any environment but local (ADR-0115)', async () => {
    const h = await harness();
    const agent = await agentWithVersions(h, {
      resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] },
    });
    const deps = { store: h.store };
    const refused = (result: { status: number; body: unknown }) => {
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        error: {
          code: 'code_tool_needs_host',
          details: [`connector:${AW_DEV_TOOLS_CONNECTOR}`, 'environment:production'],
        },
      });
    };

    expect((await point(agent, 'local', 1, deps)).status).toBe(200);
    refused(await point(agent, 'production', 1, deps));
    refused(await promoteAgent({}, await h.current(agent.id), ACTOR, deps));
    refused(await promoteAgent({ dryRun: true }, await h.current(agent.id), ACTOR, deps));
    expect(h.provider.pointerCount()).toBe(1);
  });

  it('refuses a version with code tools before the promotion bar judges it (ADR-0115)', async () => {
    const h = await harness();
    const agent = await agentWithVersions(h, {
      resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] },
    });
    const deps = { store: h.store, ceiling: barOf(0.9) };
    await point(agent, 'local', 1, deps);

    for (const result of [
      await point(agent, 'production', 1, deps),
      await promoteAgent({}, await h.current(agent.id), ACTOR, deps),
    ]) {
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({ error: { code: 'code_tool_needs_host' } });
    }
  });

  it('refuses a version with stdio connectors for any environment but local, naming them (#793)', async () => {
    const h = await harness();
    const agent = await agentWithVersions(h, {
      resources: { connectors: ['tickets', 'git', 'filesystem'] },
    });
    const deps = { store: h.store };
    const refused = (result: { status: number; body: unknown }) => {
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        error: {
          code: 'stdio_connector_needs_tool_sandbox',
          details: ['connector:filesystem', 'connector:git', 'environment:production'],
        },
      });
    };

    expect((await point(agent, 'local', 1, deps)).status).toBe(200);
    refused(await point(agent, 'production', 1, deps));
    refused(await promoteAgent({}, await h.current(agent.id), ACTOR, deps));
    refused(await promoteAgent({ dryRun: true }, await h.current(agent.id), ACTOR, deps));
    refused(
      await setAgentPointer({ environment: 'production', version: 1 }, agent, ACTOR, {
        ...deps,
        ceiling: barOf(0.9),
      }),
    );
    expect(h.provider.pointerCount()).toBe(1);
  });

  it('promotes a version whose connectors are not stdio (#793)', async () => {
    const h = await harness();
    const agent = await agentWithVersions(h, { resources: { connectors: ['tickets'] } });
    const deps = { store: h.store };
    await point(agent, 'local', 1, deps);

    const promoted = await promoteAgent({}, await h.current(agent.id), ACTOR, deps);

    expect(promoted).toMatchObject({ status: 200, body: { environment: 'production', to: 1 } });
  });

  it('rolls local back to a code-tool version: only other environments are refused', async () => {
    const h = await harness();
    const agent = await agentWithVersions(
      h,
      { resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] } },
      { instructions: 'Version two.' },
    );
    const deps = { store: h.store };
    await point(agent, 'local', 1, deps);
    await point(agent, 'local', 2, deps);

    const rolled = await rollbackAgent(
      { environment: 'local' },
      await h.current(agent.id),
      ACTOR,
      deps,
    );

    expect(rolled).toMatchObject({ status: 200, body: { environment: 'local', to: 1 } });
  });
}
