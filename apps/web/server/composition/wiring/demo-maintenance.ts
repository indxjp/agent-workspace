/**
 * The daily production test's maintenance verdicts (`PUT /api/demo/maintenance/{entry}`, read by
 * `GET /api/store/demos`) and the deploy's readiness check (`GET /api/demo/readiness`).
 */
import type { DemoEntryStates } from '../../demo/maintenance/ports';

import { createDemoMaintenanceOperations } from '../../demo/maintenance/operations';
import { createDemoReadinessCheck } from '../../demo/maintenance/readiness';
import type { DemoMaintenanceOperations, DemoReadinessCheck } from '../../demo/operator';
import type { WebSettings } from '../../settings';

/** What the composition root hands the maintenance verdicts and the readiness check. */
export interface DemoMaintenanceWiring {
  /** The database root, typed by what these operations read of it: the verdicts' repository. */
  readonly root: { readonly demoEntryStates: DemoEntryStates };
  readonly settings: Pick<WebSettings, 'demoAnthropicApiKey'>;
}

export function wireDemoMaintenance(input: DemoMaintenanceWiring): {
  readonly maintenance: DemoMaintenanceOperations | null;
  readonly readiness: DemoReadinessCheck | null;
} {
  return {
    maintenance: createDemoMaintenanceOperations(input.root.demoEntryStates),
    readiness: createDemoReadinessCheck({ apiKey: input.settings.demoAnthropicApiKey }),
  };
}
