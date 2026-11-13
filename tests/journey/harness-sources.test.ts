import { failureOf, AGENT_SOURCE, SURFACE_SOURCE } from './harness-fixtures.js';
import { describe, expect, it } from 'vitest';
import {
  agentNameOfSource,
  colourOfSurfaceSource,
  toolAgentSource,
  withSurfaceColour,
} from './harness.mjs';

describe('S2-08: the hand edits B2 and B3b make', () => {
  it('adds the orders tool and runCommands to the rendered agent', () => {
    const source = toolAgentSource(AGENT_SOURCE);
    expect(source).toContain(
      "import { defineAgent } from '@indx-workspace/sdk/define';\n\nimport ordersTool from '../tools/orders';\n",
    );
    expect(source).toContain(
      "  engine: 'claude-agent-sdk',\n  tools: [ordersTool],\n  permissions: { runCommands: true },\n",
    );
    expect(agentNameOfSource(source)).toBe('assistant');
  });

  it('refuses an agent that is not the renderer output, or already has tools', () => {
    const message =
      'the agent file is not the renderer output without tools (import and engine line)';
    expect(failureOf(() => toolAgentSource('export default {};\n')).message).toBe(message);
    expect(failureOf(() => toolAgentSource(toolAgentSource(AGENT_SOURCE))).message).toBe(message);
  });

  it('rewrites the surface colour, and refuses a file with none or a colour that is not #rrggbb', () => {
    const source = withSurfaceColour(SURFACE_SOURCE, '#16a085');
    expect(colourOfSurfaceSource(source)).toBe('#16a085');
    expect(source.replace("'#16a085'", "'#2F5FD0'")).toBe(SURFACE_SOURCE);
    expect(
      failureOf(() => withSurfaceColour("export default { name: 'main' };", '#16a085')).message,
    ).toBe('surfaces/main.ts names no theme colour (colour: #rrggbb)');
    expect(failureOf(() => withSurfaceColour(SURFACE_SOURCE, 'teal')).message).toBe(
      'teal is not a #rrggbb colour',
    );
  });
});
