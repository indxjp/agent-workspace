/**
 * The demo operator surface (internal spec, "The GCP deployment"), for the composition root to
 * install as `ApplicationContext.demoOperator`: the operator token from the settings, and the
 * operations its routes call. Each operation is wired in its own file, by the side that owns it:
 * template seeding, the sample check and the verification workspace fill by the provisioner
 * (`./demo-templates.ts`), the
 * maintenance verdicts and the readiness check (`./demo-maintenance.ts`).
 */
import type { DemoOperatorRuntime } from '../../demo/operator';
import type { WebSettings } from '../../settings';
import { wireDemoMaintenance, type DemoMaintenanceWiring } from './demo-maintenance';
import {
  wireDemoTemplateOperations,
  wireDemoVerification,
  type DemoTemplateWiring,
} from './demo-templates';

export function wireDemoOperator(input: {
  readonly settings: Pick<WebSettings, 'demoOperatorToken'>;
  readonly templates: DemoTemplateWiring;
  readonly maintenance: DemoMaintenanceWiring;
}): DemoOperatorRuntime {
  const { maintenance, readiness } = wireDemoMaintenance(input.maintenance);
  const templates = wireDemoTemplateOperations(input.templates);
  return {
    token: input.settings.demoOperatorToken,
    templates,
    verification: wireDemoVerification(input.templates, templates),
    maintenance,
    readiness,
  };
}
