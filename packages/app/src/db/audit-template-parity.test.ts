import { renderAppSpec, renderGeneratorTemplate } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { createAgentPanelSessionsSql } from './agent-panel-sessions.js';
import { createAuditTableSql } from './audit.js';
import { createChannelEventsSql } from './channel-events.js';
import { createRecipeTablesSql } from './recipe-tables.js';

// The app template's first migration is plain text with a `{{schema}}` token, so `npm create`
// and `aw generate app` can write it before the app kit is installed. This keeps that text equal
// to the tables the app kit itself writes to: the audit table, then the agent panel's sessions
// (issue #1509), one statement each.
describe("the app template's first migration", () => {
  it.each(['service-desk', 'crm', 'a'])(
    'renders as createAuditTableSql(%j) and createAgentPanelSessionsSql',
    (appName) => {
      const files = renderGeneratorTemplate('app', renderAppSpec(appName));
      const migration = files.find((file) => file.path === 'db/migrations/0000_app_kit.sql');

      expect(migration?.contents).toBe(
        [createAuditTableSql(appName), createAgentPanelSessionsSql(appName)].join(
          '--> statement-breakpoint\n',
        ),
      );
    },
  );
});

// The recipe tables (issue #1513) are the template's second migration, forward-only: the first is
// left as apps already applied it.
describe("the app template's recipe migration", () => {
  it.each(['service-desk', 'crm', 'a'])('renders as createRecipeTablesSql(%j)', (appName) => {
    const files = renderGeneratorTemplate('app', renderAppSpec(appName));
    const migration = files.find((file) => file.path === 'db/migrations/0001_app_kit_recipes.sql');
    expect(migration?.contents).toBe(createRecipeTablesSql(appName));
  });

  it('is the second entry of the journal', () => {
    const files = renderGeneratorTemplate('app', renderAppSpec('desk'));
    const journal = files.find((file) => file.path === 'db/migrations/meta/_journal.json');
    const entries = (JSON.parse(journal?.contents ?? '{}') as { entries: { tag: string }[] })
      .entries;
    expect(entries.map((entry) => entry.tag).slice(0, 2)).toEqual([
      '0000_app_kit',
      '0001_app_kit_recipes',
    ]);
  });
});

// The channel events (issue #1518) are the template's third migration, forward-only too.
describe("the app template's channel migration", () => {
  it.each(['service-desk', 'crm', 'a'])('renders as createChannelEventsSql(%j)', (appName) => {
    const files = renderGeneratorTemplate('app', renderAppSpec(appName));
    const migration = files.find((file) => file.path === 'db/migrations/0002_app_kit_channels.sql');
    expect(migration?.contents).toBe(createChannelEventsSql(appName));
  });

  it('is the third and last entry of the journal', () => {
    const files = renderGeneratorTemplate('app', renderAppSpec('desk'));
    const journal = files.find((file) => file.path === 'db/migrations/meta/_journal.json');
    const entries = (JSON.parse(journal?.contents ?? '{}') as { entries: { tag: string }[] })
      .entries;
    expect(entries.map((entry) => entry.tag)).toEqual([
      '0000_app_kit',
      '0001_app_kit_recipes',
      '0002_app_kit_channels',
    ]);
  });
});
