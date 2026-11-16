import path from 'node:path';
import { beforeAll } from 'vitest';
import { renderOpenApiDocument } from '../../scripts/docs/generate-openapi.mjs';

export const repoRoot = path.resolve(import.meta.dirname, '../..');

export let rendered: string;

export let document: Record<string, unknown>;

beforeAll(async () => {
  rendered = await renderOpenApiDocument(repoRoot);
  document = JSON.parse(rendered) as Record<string, unknown>;
});

export const routeKey = (method: string, routePath: string): string =>
  `${method.toUpperCase()} ${routePath}`;
