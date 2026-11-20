/** The props of `PageView` (issue #1521). */
import type { PageRecord } from '../db/page-port.js';
import type { DefinedPages } from '../pages/define-pages.js';
import type { FieldMap } from '../resource.js';
import type { AgentPanelClient } from './agent-panel-client.js';
import type { AgentPanelAgent, AgentPanelProps } from './agent-panel.js';
import type { AppLocale } from './locale.js';
import type { PageClient } from './page-client.js';

/** The props of {@link PageView}. */
export interface PageViewProps<F extends FieldMap = FieldMap> {
  readonly resource: DefinedPages<F>;
  readonly id: string;
  /** The agents the actions and the panel offer; no actions and no panel when none. */
  readonly agents?: readonly AgentPanelAgent[] | undefined;
  /** The Agent Workspace origin a revision's run link opens on: `${platformUrl}/runs?run=<id>`. */
  readonly platformUrl?: string | undefined;
  /** The name of the person a principal id is; the id's first group when not given. */
  readonly personName?: ((principalId: string) => string | undefined) | undefined;
  /** Called with the page after a save, a restore, or an agent's change was loaded. */
  readonly onChanged?: ((page: PageRecord<F>) => void) | undefined;
  /** Passed to the agent panel. */
  readonly renderApproval?: AgentPanelProps['renderApproval'];
  /** The language of the view's words; the `AppTheme`'s when not given, `en` outside one. */
  readonly locale?: AppLocale | undefined;
  /** The client of the pages' routes; one for the page's own origin when not given. */
  readonly client?: PageClient<F> | undefined;
  /** The agent panel's client; one for the page's own origin when not given. */
  readonly panelClient?: AgentPanelClient | undefined;
}
