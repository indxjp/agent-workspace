/**
 * `agentFromVersionBody` on the gallery: each use case's body, rebuilt from the body, the project
 * file and the project's tool modules, in memory, keeps its file grants, its tools' definitions
 * (identity included) and its `mcp()` connectors, and pushes as the same body.
 *
 * The definitions are imported statically: the repository's import-boundary gate
 * (`tests/no-sdk-import.test.ts`) refuses a computed `import()`.
 */
import path from 'node:path';

import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import {
  agentFromVersionBody,
  files,
  toAgentVersionBody,
  toolDefinitionsOf,
  toolModulesOf,
} from '@indx-workspace/sdk/define';
import { describe, expect, it } from 'vitest';

import cadDraftingAgent from '../cad-drafting/agents/cad-drafting.ts';
import cadDraftingSurface from '../cad-drafting/surfaces/design-desk.ts';
import contractReviewAgent from '../contract-review/agents/contract-review.ts';
import contractReviewSurface from '../contract-review/surfaces/legal-desk.ts';
import customerInquiryAgent from '../customer-inquiry/agents/customer-inquiry.ts';
import customerInquirySurface from '../customer-inquiry/surfaces/support.ts';
import * as crm from '../customer-inquiry/tools/crm.ts';
import excelConsolidationAgent from '../excel-consolidation/agents/excel-consolidation.ts';
import excelConsolidationSurface from '../excel-consolidation/surfaces/planning.ts';
import maintenanceAgent from '../maintenance-troubleshooting/agents/maintenance-troubleshooting.ts';
import maintenanceSurface from '../maintenance-troubleshooting/surfaces/floor.ts';
import * as maintenance from '../maintenance-troubleshooting/tools/maintenance.ts';
import manualSearchAgent from '../manual-search/agents/manual-search.ts';
import manualSearchSurface from '../manual-search/surfaces/manual-desk.ts';
import meetingMinutesAgent from '../meeting-minutes/agents/meeting-minutes.ts';
import meetingMinutesSurface from '../meeting-minutes/surfaces/minutes.ts';
import * as tracker from '../meeting-minutes/tools/tracker.ts';
import qualityDefectAgent from '../quality-defect/agents/quality-defect.ts';
import qualityDefectSurface from '../quality-defect/surfaces/qa.ts';
import * as qms from '../quality-defect/tools/qms.ts';
import quotationAgent from '../quotation/agents/quotation.ts';
import quotationSurface from '../quotation/surfaces/quote-desk.ts';
import * as erp from '../quotation/tools/erp.ts';
import ringiReviewAgent from '../ringi-review/agents/ringi-review.ts';
import ringiReviewSurface from '../ringi-review/surfaces/ringi-desk.ts';
import * as workflow from '../ringi-review/tools/workflow.ts';
import { loadGalleryProject } from './project.ts';
import { GALLERY_DIR } from './registry.ts';

interface Case {
  readonly id: string;
  readonly agent: { readonly file: string; readonly definition: unknown };
  readonly surface: { readonly file: string; readonly definition: unknown };
  /** The project's tool modules, by project path. */
  readonly modules: readonly {
    readonly path: string;
    readonly namespace: Record<string, unknown>;
  }[];
  /** Tools the agent imports from a module: `[name, module]`; the export is named as the tool. */
  readonly imports: readonly (readonly [string, string])[];
  /** The agent's `mcp()` connectors, which agent-workspace.yaml declares. */
  readonly mcp: readonly string[];
}

const none = { modules: [], imports: [], mcp: [] } as const;

const CASES: readonly Case[] = [
  {
    id: 'manual-search',
    agent: { file: 'manual-search', definition: manualSearchAgent },
    surface: { file: 'manual-desk', definition: manualSearchSurface },
    ...none,
  },
  {
    id: 'cad-drafting',
    agent: { file: 'cad-drafting', definition: cadDraftingAgent },
    surface: { file: 'design-desk', definition: cadDraftingSurface },
    ...none,
  },
  {
    id: 'quotation',
    agent: { file: 'quotation', definition: quotationAgent },
    surface: { file: 'quote-desk', definition: quotationSurface },
    modules: [{ path: 'tools/erp.ts', namespace: erp }],
    imports: [['erp', 'tools/erp.ts']],
    mcp: [],
  },
  {
    id: 'ringi-review',
    agent: { file: 'ringi-review', definition: ringiReviewAgent },
    surface: { file: 'ringi-desk', definition: ringiReviewSurface },
    modules: [{ path: 'tools/workflow.ts', namespace: workflow }],
    imports: [['workflow', 'tools/workflow.ts']],
    mcp: ['authority'],
  },
  {
    id: 'customer-inquiry',
    agent: { file: 'customer-inquiry', definition: customerInquiryAgent },
    surface: { file: 'support', definition: customerInquirySurface },
    modules: [{ path: 'tools/crm.ts', namespace: crm }],
    imports: [['crm', 'tools/crm.ts']],
    mcp: [],
  },
  {
    id: 'excel-consolidation',
    agent: { file: 'excel-consolidation', definition: excelConsolidationAgent },
    surface: { file: 'planning', definition: excelConsolidationSurface },
    ...none,
  },
  {
    id: 'contract-review',
    agent: { file: 'contract-review', definition: contractReviewAgent },
    surface: { file: 'legal-desk', definition: contractReviewSurface },
    ...none,
  },
  {
    id: 'meeting-minutes',
    agent: { file: 'meeting-minutes', definition: meetingMinutesAgent },
    surface: { file: 'minutes', definition: meetingMinutesSurface },
    modules: [{ path: 'tools/tracker.ts', namespace: tracker }],
    imports: [['tracker', 'tools/tracker.ts']],
    mcp: ['task-tracker'],
  },
  {
    id: 'maintenance-troubleshooting',
    agent: { file: 'maintenance-troubleshooting', definition: maintenanceAgent },
    surface: { file: 'floor', definition: maintenanceSurface },
    modules: [{ path: 'tools/maintenance.ts', namespace: maintenance }],
    imports: [['maintenance', 'tools/maintenance.ts']],
    mcp: [],
  },
  {
    id: 'quality-defect',
    agent: { file: 'quality-defect', definition: qualityDefectAgent },
    surface: { file: 'qa', definition: qualityDefectSurface },
    modules: [{ path: 'tools/qms.ts', namespace: qms }],
    imports: [['qms', 'tools/qms.ts']],
    mcp: [],
  },
];

describe('agentFromVersionBody on the gallery', () => {
  it('keeps the manual-search file grant', async () => {
    const dir = path.join(GALLERY_DIR, 'manual-search');
    const { project, agents, surfaces } = await loadGalleryProject(dir, {
      'agents/manual-search.ts': manualSearchAgent,
      'surfaces/manual-desk.ts': manualSearchSurface,
    });
    const [entry] = agents;
    if (entry === undefined) throw new Error('manual-search has no agent');
    const { value, dropped } = agentFromVersionBody({ body: entry.body, project, surfaces });
    expect(dropped).toStrictEqual([]);
    expect(value.agent.files).toStrictEqual([files('manuals', 'read')]);
  });

  it.each(CASES)('$id converts with nothing dropped and pushes as the same body', async (use) => {
    const { project, agents, surfaces } = await loadGalleryProject(path.join(GALLERY_DIR, use.id), {
      [`agents/${use.agent.file}.ts`]: use.agent.definition,
      [`surfaces/${use.surface.file}.ts`]: use.surface.definition,
    });
    const [entry] = agents;
    if (entry === undefined) throw new Error(`${use.id} has no agent`);

    const { value, dropped } = agentFromVersionBody({
      body: entry.body,
      project,
      toolModules: toolModulesOf(use.modules),
      surfaces,
    });

    expect(dropped).toStrictEqual([]);
    expect(
      AgentVersionBodySchema.parse(
        toAgentVersionBody(value.agent, { surfaces, defaultEngine: project.engine }),
      ),
    ).toStrictEqual(AgentVersionBodySchema.parse(entry.body));
    expect(toolDefinitionsOf(value.agent)).toStrictEqual(toolDefinitionsOf(entry.definition));
    expect(value.imports).toStrictEqual(
      use.imports.map(([name, module]) => ({
        kind: 'openapi',
        name,
        module,
        exportName: name,
      })),
    );
    expect(value.connectors).toStrictEqual(
      Object.fromEntries(use.mcp.map((name) => [name, project.connectors?.[name]])),
    );
    // The yaml's own URLs, not the object that was read.
    const literal: Readonly<Record<string, string>> = {
      authority: 'http://127.0.0.1:8790/mcp',
      'task-tracker': 'http://127.0.0.1:8788/mcp',
    };
    for (const name of use.mcp) {
      expect(value.connectors[name]?.url).toBe(literal[name]);
    }
  });
});
