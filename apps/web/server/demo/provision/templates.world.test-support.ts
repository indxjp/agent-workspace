/**
 * The worlds `templates.contract.ts` runs in: the stores behind {@link DemoTemplates} built on
 * memory and on a real PostgreSQL, and the readers and seeders over them. Both are made by one
 * function (`templates.world.build.test-support.ts`), so the two worlds differ only in the stores
 * and in how a template workspace is made.
 */
export { createMemoryTemplatesWorld } from './templates.world.memory.test-support';
export { openPostgresTemplatesWorld } from './templates.world.postgres.test-support';
