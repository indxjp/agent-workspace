import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { createRecipeTablesSql, recipeTables } from './recipe-tables.js';

/** The quoted column names of the `CREATE TABLE` of `table` in `text`, in order. */
function sqlColumns(text: string, table: string): string[] {
  const start = text.indexOf(`."${table}" (`);
  const body = text.slice(start, text.indexOf('\n);', start));
  return [...body.matchAll(/^ {2}"([a-z_]+)" /gmu)].map((match) => match[1] ?? '');
}

describe('the recipe tables', () => {
  it('render the same SQL for the same app, in its own schema', () => {
    expect(createRecipeTablesSql('service-desk')).toBe(createRecipeTablesSql('service-desk'));
    expect(createRecipeTablesSql('service-desk')).toContain('"app_service_desk"."recipe_runs"');
    expect(createRecipeTablesSql('service-desk').split('--> statement-breakpoint\n')).toHaveLength(
      2,
    );
    expect(() => createRecipeTablesSql('Not An App')).toThrow(RangeError);
  });

  it('declare in Drizzle exactly the columns the SQL creates', () => {
    const text = createRecipeTablesSql('desk');
    const { recipeRuns, recipeSteps } = recipeTables('desk');
    for (const [table, name] of [
      [recipeRuns, 'recipe_runs'],
      [recipeSteps, 'recipe_steps'],
    ] as const) {
      const config = getTableConfig(table);
      expect(config.schema).toBe('app_desk');
      expect(config.name).toBe(name);
      expect(config.columns.map((column) => column.name)).toEqual(sqlColumns(text, name));
    }
  });

  it('keep platform ids as text without foreign keys, pairing a step with its run’s workspace', () => {
    const text = createRecipeTablesSql('desk');
    expect(text.match(/FOREIGN KEY/gu)).toHaveLength(1);
    expect(text).toContain(
      'FOREIGN KEY ("workspace_id", "recipe_run_id") REFERENCES "app_desk"."recipe_runs" ("workspace_id", "id") ON DELETE CASCADE',
    );
    for (const column of ['run_id', 'continuation_run_id', 'started_by']) {
      expect(text).toMatch(new RegExp(`"${column}" text,`, 'u'));
    }
    expect(text).toContain('UNIQUE ("workspace_id", "recipe", "dedupe_key")');
  });
});
