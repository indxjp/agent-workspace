/**
 * The examples `examples_get` serves are copies of the gallery agents' definition bodies. This
 * test loads each gallery project through the same harness the gallery's own suites use and
 * requires the copy to equal the body it produces, so a gallery body that changes without its
 * copy fails here.
 */
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import manualSearchAgent from '../../../../../tests/gallery/manual-search/agents/manual-search.ts';
import manualSearchSurface from '../../../../../tests/gallery/manual-search/surfaces/manual-desk.ts';
import cadDraftingAgent from '../../../../../tests/gallery/cad-drafting/agents/cad-drafting.ts';
import cadDraftingSurface from '../../../../../tests/gallery/cad-drafting/surfaces/design-desk.ts';
import quotationAgent from '../../../../../tests/gallery/quotation/agents/quotation.ts';
import quotationSurface from '../../../../../tests/gallery/quotation/surfaces/quote-desk.ts';
import ringiReviewAgent from '../../../../../tests/gallery/ringi-review/agents/ringi-review.ts';
import ringiReviewSurface from '../../../../../tests/gallery/ringi-review/surfaces/ringi-desk.ts';
import customerInquiryAgent from '../../../../../tests/gallery/customer-inquiry/agents/customer-inquiry.ts';
import customerInquirySurface from '../../../../../tests/gallery/customer-inquiry/surfaces/support.ts';
import excelConsolidationAgent from '../../../../../tests/gallery/excel-consolidation/agents/excel-consolidation.ts';
import excelConsolidationSurface from '../../../../../tests/gallery/excel-consolidation/surfaces/planning.ts';
import contractReviewAgent from '../../../../../tests/gallery/contract-review/agents/contract-review.ts';
import contractReviewSurface from '../../../../../tests/gallery/contract-review/surfaces/legal-desk.ts';
import meetingMinutesAgent from '../../../../../tests/gallery/meeting-minutes/agents/meeting-minutes.ts';
import meetingMinutesSurface from '../../../../../tests/gallery/meeting-minutes/surfaces/minutes.ts';
import maintenanceAgent from '../../../../../tests/gallery/maintenance-troubleshooting/agents/maintenance-troubleshooting.ts';
import maintenanceSurface from '../../../../../tests/gallery/maintenance-troubleshooting/surfaces/floor.ts';
import qualityDefectAgent from '../../../../../tests/gallery/quality-defect/agents/quality-defect.ts';
import qualityDefectSurface from '../../../../../tests/gallery/quality-defect/surfaces/qa.ts';
import { loadGalleryProject } from '../../../../../tests/gallery/harness/project.ts';
import { GALLERY_DIR, loadUseCases } from '../../../../../tests/gallery/harness/registry.ts';
import { EXAMPLES, getExample } from './index';

const DEFINITIONS: readonly (readonly [string, string, unknown, unknown])[] = [
  ['manual-search', 'manual-desk', manualSearchAgent, manualSearchSurface],
  ['cad-drafting', 'design-desk', cadDraftingAgent, cadDraftingSurface],
  ['quotation', 'quote-desk', quotationAgent, quotationSurface],
  ['ringi-review', 'ringi-desk', ringiReviewAgent, ringiReviewSurface],
  ['customer-inquiry', 'support', customerInquiryAgent, customerInquirySurface],
  ['excel-consolidation', 'planning', excelConsolidationAgent, excelConsolidationSurface],
  ['contract-review', 'legal-desk', contractReviewAgent, contractReviewSurface],
  ['meeting-minutes', 'minutes', meetingMinutesAgent, meetingMinutesSurface],
  ['maintenance-troubleshooting', 'floor', maintenanceAgent, maintenanceSurface],
  ['quality-defect', 'qa', qualityDefectAgent, qualityDefectSurface],
];

/** The harness's body for a gallery id: `toAgentVersionBody` over the loaded project, as JSON. */
async function galleryBody(id: string): Promise<unknown> {
  const row = DEFINITIONS.find(([name]) => name === id);
  if (row === undefined) throw new Error(`no gallery definitions for ${id}`);
  const [, surface, agent, surfaceDefinition] = row;
  const project = await loadGalleryProject(path.join(GALLERY_DIR, id), {
    [`agents/${id}.ts`]: agent,
    [`surfaces/${surface}.ts`]: surfaceDefinition,
  });
  const [only, ...rest] = project.agents;
  if (only === undefined || rest.length > 0) throw new Error(`${id} must hold exactly one agent`);
  return JSON.parse(JSON.stringify(only.body));
}

describe('the examples', () => {
  it('are the ten gallery use cases, once each', () => {
    const galleryIds = loadUseCases().map((useCase) => useCase.benchmark.id);
    expect(EXAMPLES).toHaveLength(10);
    expect(new Set(EXAMPLES.map((example) => example.name)).size).toBe(10);
    expect(EXAMPLES.map((example) => example.name).sort()).toEqual([...galleryIds].sort());
    for (const example of EXAMPLES) {
      expect(example.title.length).toBeGreaterThan(0);
      expect(example.summary).not.toContain('\n');
      expect(getExample(example.name)).toBe(example);
    }
    expect(getExample('nope')).toBeUndefined();
  });

  it.each(loadUseCases().map((useCase) => useCase.benchmark.id))(
    '%s equals its gallery body',
    async (id) => {
      const example = getExample(id);
      expect(example, `no example named ${id}`).toBeDefined();
      expect(JSON.parse(JSON.stringify(example?.body))).toEqual(await galleryBody(id));
    },
  );
});
