/**
 * What every {@link DemoTemplates} must do, written against the port and run against a world built
 * on memory stores and against one built on PostgreSQL (`templates.test.ts`). A world is the
 * template workspaces and the visitors' demo workspaces behind the port, with the readers a test
 * needs to look at what a copy made. The groups of checks live beside this file, one per concern.
 */
import { describe } from 'vitest';

import { describeCopiedAgent } from './templates.contract-agent';
import { describeCopiedConnectors } from './templates.contract-connectors';
import { describeCopiedSkills } from './templates.contract-skills';
import { describeCopyBehaviour } from './templates.contract-copies';
import { describeDeclaredConnectorRecords } from './templates.contract-records';
import { describeSandboxAndModel } from './templates.contract-sandbox';
import { describeVerificationCopy } from './templates.contract-verification';
import type { MakeDemoTemplatesWorld } from './templates.contract-world';

export {
  TEST_DEMO_API_KEY,
  type DemoTemplatesWorld,
  type SeedConnector,
  type TemplateSpec,
} from './templates.contract-world';

/** Register every conformance check against the world `make` builds. */
export function describeDemoTemplatesConformance(
  label: string,
  make: MakeDemoTemplatesWorld,
): void {
  describe(`DemoTemplates: ${label}`, () => {
    describeCopiedAgent(make);
    describeCopiedSkills(make);
    describeCopyBehaviour(make);
    describeCopiedConnectors(make);
    describeVerificationCopy(make);
    describeSandboxAndModel(make);
    describeDeclaredConnectorRecords(make);
  });
}
