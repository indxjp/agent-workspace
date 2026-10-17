/**
 * Gap probes: executable statements that a capability is still missing.
 *
 * Each probe asks the published contracts or the SDK whether the capability exists and answers
 * `true` when it does. `../probes.test.ts` asserts every probe answers `false`. The day the SDK
 * gains one, its probe flips, that test fails, and the failure names the benchmarks citing it: a
 * gap the gallery reports cannot outlive the gap itself. Probes read only public surfaces —
 * `@indx-workspace/contracts`, `@indx-workspace/sdk` and its `/define` and `/testing` subpaths —
 * because those are what a developer building a use case can rely on.
 */
import { ProjectConnectorSchema } from '@indx-workspace/contracts/project-file';
import { ProjectPolicySchema } from '@indx-workspace/contracts/policy-ceiling';
import { API_ROUTES } from '@indx-workspace/contracts/routes';
import { AGENT_FRAME_NAMES } from '@indx-workspace/contracts/run-events';
import {
  RUN_STATUSES,
  RunResourceSchema,
  StartRunRequestSchema,
} from '@indx-workspace/contracts/runs';
import { SurfaceDefinitionSchema } from '@indx-workspace/contracts/surfaces';
import { createClient } from '@indx-workspace/sdk';
import { openapiTool } from '@indx-workspace/sdk/define';
import { fetchDouble, fixtures, jsonResponse } from '@indx-workspace/sdk/testing';

export interface Probe {
  /** What the capability is, phrased so "… is still absent" reads as the test title. */
  readonly title: string;
  /** Where to look when the probe flips. */
  readonly where: string;
  readonly present: () => boolean | Promise<boolean>;
}

const routeMatches = (pattern: RegExp): boolean =>
  API_ROUTES.some((route) => pattern.test(route.path));

export const PROBES = {
  'run-output-schema': {
    title: 'a run that takes an output schema or returns its final answer',
    where: 'packages/contracts/src/runs.ts (StartRunRequestSchema, RunResourceSchema)',
    present: () =>
      StartRunRequestSchema.safeParse({ prompt: 'x', outputSchema: { type: 'object' } }).success ||
      // The run schema is strict, so it accepts an answer field only once the contract has one.
      ['output', 'answer', 'result', 'finalMessage'].some(
        (key) =>
          RunResourceSchema.safeParse({ ...fixtures.run({ status: 'completed' }), [key]: 'x' })
            .success,
      ),
  },
  'run-approval': {
    title: 'a run that pauses for a person to approve and then resumes',
    where: 'packages/contracts/src/policy-ceiling.ts (approval), runs.ts (RUN_STATUSES)',
    present: () =>
      ProjectPolicySchema.safeParse({ approval: { tools: ['*'] } }).success ||
      RUN_STATUSES.some((status) => /await|pause|input|approv/u.test(status)),
  },
  'run-handoff': {
    title: 'a run event that hands the conversation to a person',
    where: 'packages/contracts/src/run-events.ts (AGENT_FRAME_NAMES)',
    present: () => AGENT_FRAME_NAMES.some((name) => /handoff|escalat|human/u.test(name)),
  },
  'run-attachments': {
    title: 'a run started with attached files, images or audio',
    where: 'packages/contracts/src/runs.ts (StartRunRequestSchema)',
    present: () =>
      StartRunRequestSchema.safeParse({ prompt: 'x', attachments: [{ path: 'photo.jpg' }] })
        .success,
  },
  'surface-attachments': {
    title: 'a surface that accepts attachments from the person asking',
    where: 'packages/contracts/src/surfaces.ts (SurfacePartsSchema)',
    present: () =>
      SurfaceDefinitionSchema.safeParse({
        name: 'probe',
        agent: 'probe',
        parts: { attachments: true },
      }).success,
  },
  'surface-mcp-tool-results': {
    title: 'a surface toolResults entry that can name the gallery MCP tool search_manual',
    where:
      'packages/contracts/src/surfaces.ts (SURFACE_TOOL_NAME_PATTERN); packages/react/src/surface-chat.tsx (exact match on the run tool name)',
    // A connector whose name is not a usable slug is keyed mcp__connector-<uuid>__<tool> (#1109):
    // 53 characters plus the tool's own name, so any tool name over 11 characters exceeds the 64 a
    // toolResults key may have, and the name differs in every workspace even when it fits. The
    // widget matches the key exactly, so a surface cannot render such a tool's result as a card.
    present: () =>
      SurfaceDefinitionSchema.safeParse({
        name: 'probe',
        agent: 'probe',
        toolResults: {
          'mcp__connector-6b1c1f0e-0000-4000-8000-000000000001__search_manual': 'card',
        },
      }).success,
  },
  'openapi-write': {
    title: 'an openapiTool() that may call a write operation',
    where: 'packages/sdk/src/define/references.ts (openapiTool allow rules)',
    present: () => {
      try {
        openapiTool({ name: 'probe', spec: 'apis/probe.openapi.json', allow: ['POST /orders'] });
        return true;
      } catch {
        return false;
      }
    },
  },
  'inbound-trigger': {
    title: 'a route that starts a run on an event or a schedule',
    where: 'packages/contracts/src/routes.ts (API_ROUTES)',
    present: () => routeMatches(/trigger|webhook|schedule|cron/u),
  },
  'built-in-index': {
    title: 'a built-in search index, embeddings or retrieval route',
    where: 'packages/contracts/src/routes.ts (API_ROUTES); packages/core/src/db/schema/files.ts',
    present: () => routeMatches(/search|index|embedding|retriev|vector/u),
  },
  'project-file-stdio': {
    title: 'a stdio MCP connector declared in agent-workspace.yaml',
    where: 'packages/contracts/src/project-file.ts (ProjectConnectorSchema)',
    present: () =>
      ProjectConnectorSchema.safeParse({ url: 'https://mcp.example.co.jp/mcp', transport: 'stdio' })
        .success,
  },
  'run-start-idempotency': {
    title: 'an idempotency key on runs.start',
    where: 'packages/sdk/src/resources/runs.ts (start); roadmap S-6',
    present: async () => {
      const run = fixtures.run();
      const api = fetchDouble(() =>
        jsonResponse(202, { run, events: `/api/runs/${run.id}/events` }),
      );
      const aw = createClient({
        baseUrl: 'https://workspace.example.co.jp',
        auth: { kind: 'api-key', apiKey: 'aw_probe' },
        fetch: api.fetch,
      });
      await aw.runs.start(run.agentId, { prompt: 'x' });
      return api.calls.some((call) => call.headers.has('idempotency-key'));
    },
  },
} as const satisfies Readonly<Record<string, Probe>>;

export type ProbeId = keyof typeof PROBES;
