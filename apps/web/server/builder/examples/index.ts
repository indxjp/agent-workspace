/**
 * The examples `examples_get` serves: a closed list of ten, in the gallery's order. Each is a copy
 * of a gallery agent's definition body, stored as JSON data; `examples-drift.test.ts` fails if a
 * gallery body changes without its copy. Every copy is parsed with the contracts schema when this
 * module loads, so an invalid one fails loudly. No I/O.
 */
import {
  AgentVersionBodySchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import { z } from 'zod';

import manualSearch from './manual-search.json' with { type: 'json' };
import cadDrafting from './cad-drafting.json' with { type: 'json' };
import quotation from './quotation.json' with { type: 'json' };
import ringiReview from './ringi-review.json' with { type: 'json' };
import customerInquiry from './customer-inquiry.json' with { type: 'json' };
import excelConsolidation from './excel-consolidation.json' with { type: 'json' };
import contractReview from './contract-review.json' with { type: 'json' };
import meetingMinutes from './meeting-minutes.json' with { type: 'json' };
import maintenance from './maintenance-troubleshooting.json' with { type: 'json' };
import qualityDefect from './quality-defect.json' with { type: 'json' };

const ExampleFileSchema = z.strictObject({
  name: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  body: AgentVersionBodySchema,
});

export interface Example {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly body: AgentVersionBody;
}

function parse(file: unknown): Example {
  return ExampleFileSchema.parse(file);
}

export const EXAMPLES: readonly Example[] = [
  parse(manualSearch),
  parse(cadDrafting),
  parse(quotation),
  parse(ringiReview),
  parse(customerInquiry),
  parse(excelConsolidation),
  parse(contractReview),
  parse(meetingMinutes),
  parse(maintenance),
  parse(qualityDefect),
];

export function getExample(name: string): Example | undefined {
  return EXAMPLES.find((entry) => entry.name === name);
}
