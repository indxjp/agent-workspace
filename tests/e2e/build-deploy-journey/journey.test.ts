import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { renderProjectFiles } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { agentWithTool, chatNonce, composeOverride } from './journey.e2e.mjs';

describe('the build-to-deploy journey helpers (issue #801)', () => {
  const rendered = String(
    renderProjectFiles(withRecommendedAnswers({ 'setup.theme': 'support' }), {
      name: 'demo',
    }).find((file) => file.path.startsWith('agents/'))?.contents,
  );

  it('lists the code tool and sets the model on the real rendered support agent', () => {
    const edited = agentWithTool(rendered, "'anthropic default'");
    expect(edited).toContain("import getOrder from '../tools/get-order';");
    expect(edited).toContain('  tools: [getOrder],');
    expect(edited).toContain("  model: 'anthropic default',");
    expect(edited).not.toContain("model: 'default'");
  });

  it('stops when the renderer moved an anchor', () => {
    expect(() => agentWithTool(rendered.replace("model: 'default'", "model: 'x'"), "'y'")).toThrow(
      /agent file has no/u,
    );
  });

  it('builds a chat nonce the fake provider answers with a tool call', () => {
    // The same pattern as `NONCE` in tests/journey/fake-anthropic-tools.mjs.
    expect(chatNonce()).toMatch(/^e2e-nonce-[a-z0-9]+$/u);
  });

  it('writes the tool sandbox wiring the single-vm template lacks', () => {
    const override = composeOverride({
      project: 'demo',
      nodeImage: `node@sha256:${'a'.repeat(64)}`,
      controlPort: 18083,
      fixture: '/work/.e2e',
      toolHost: `localhost:5000/agent-workspace/tool-host@sha256:${'b'.repeat(64)}`,
      egressProxy: `localhost:5000/agent-workspace/egress-proxy@sha256:${'c'.repeat(64)}`,
    });
    expect(override.match(/AGENT_WORKSPACE_TOOL_HOST_IMAGE: \S+@sha256:b{64}/gu)).toHaveLength(2);
    expect(override).toContain('AGENT_WORKSPACE_TOOL_NETWORK: demo-tool-sandbox');
    expect(override).toContain('RUNTIME_PROXY_BYPASS: gateway');
    expect(override).toMatch(/internal: true[\s\S]*agent-workspace\.runtime: docker-network/u);
    // The sandbox images sit in web's `environment:` mapping, not under `depends_on:` (the first
    // CI run failed `docker compose config` on exactly that).
    const web = /^ {2}web:\n([\s\S]*?)^ {2}\S/mu.exec(override)?.[1] ?? '';
    const environment = /^ {4}environment:\n((?: {6}.*\n)+)/mu.exec(web)?.[1] ?? '';
    expect(environment).toContain('AGENT_WORKSPACE_EGRESS_PROXY_IMAGE:');
    expect(environment).toContain('AGENT_WORKSPACE_TOOL_HOST_IMAGE:');
    expect(web).toMatch(/depends_on:\n {6}fake-anthropic: \{ condition: service_healthy \}\n$/u);
  });
});
