import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/** The distDir of the embedded build; `apps/web/next.config.ts` accepts it (`^\.next[\w.-]*$`). */
export const EMBEDDED_NEXT_DIST_DIR = '.next-embedded';

/**
 * The variable Next's own standalone server sets to the resolved config of the build, so that
 * loading the config neither reads `next.config` nor loads the build-time modules (webpack) its
 * webpack hook needs. A private Next contract (ADR-0140): the boot smoke of the release fails if a
 * Next upgrade changes it.
 */
export const NEXT_STANDALONE_CONFIG_ENV = '__NEXT_PRIVATE_STANDALONE_CONFIG';

const RequiredServerFilesSchema = z.looseObject({ config: z.looseObject({}) });

/**
 * The value of {@link NEXT_STANDALONE_CONFIG_ENV} for the build in `webDirectory`: the `config` of
 * the `required-server-files.json` that `next build` wrote, as JSON.
 */
export function standaloneNextConfig(webDirectory: string): string {
  const file = path.join(webDirectory, EMBEDDED_NEXT_DIST_DIR, 'required-server-files.json');
  const { config } = RequiredServerFilesSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  return JSON.stringify(config);
}
