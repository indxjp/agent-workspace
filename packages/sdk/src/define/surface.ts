import {
  SurfaceDefinitionSchema,
  type SurfaceDefinition,
  type SurfaceDefinitionInput,
} from '@indx-workspace/contracts/surfaces';

import { brand, hasBrand, type Branded } from './brand.js';
import { DefinitionError, issuesFromZod } from './errors.js';

/** What {@link defineSurface} returns: the surface as written, frozen and branded. */
export type DefinedSurface = SurfaceDefinition & Branded<'surface'>;

/**
 * Defines one surface as code — the hosted widget an agent answers in: its name (the `<name>` of
 * `/p/s/<name>`), the agent it talks to, its look (theme, logo, title) and layout and parts, and
 * where it may be embedded (`allowedOrigins`) with its `limits`.
 *
 * The input is exactly the contract's `SurfaceDefinitionSchema` (contract C3): the result parses
 * unchanged with it. Rung 2 is complete (ADR-0108 SD10), attachments included (`parts.attachments`, ADR-0146); `audience` is refused.
 *
 * @throws {DefinitionError} with every reason the input was refused.
 */
export function defineSurface(input: SurfaceDefinitionInput): DefinedSurface {
  const result = SurfaceDefinitionSchema.safeParse(input);
  if (!result.success) {
    throw new DefinitionError('defineSurface()', issuesFromZod(result.error));
  }
  return brand({ ...result.data }, 'surface');
}

/** Whether `value` was made by {@link defineSurface} — in this copy of the SDK or another. */
export function isDefinedSurface(value: unknown): value is DefinedSurface {
  return hasBrand(value, 'surface');
}
