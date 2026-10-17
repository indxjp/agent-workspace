import { z } from 'zod';

/**
 * The complete permission set carried by every agent request and response, in the specification's
 * order. `apps/web/server/agents/contract.test.ts` keeps this list aligned with the database schema.
 */
export const AGENT_PERMISSION_KEYS = [
  'readFiles',
  'writeFiles',
  'runCommands',
  'unrestrictedNetwork',
] as const;

export const AgentPermissionsSchema = z
  .object({
    readFiles: z.boolean(),
    writeFiles: z.boolean(),
    runCommands: z.boolean(),
    unrestrictedNetwork: z.boolean(),
  })
  .strict()
  .readonly();

export type AgentPermissionKey = (typeof AGENT_PERMISSION_KEYS)[number];
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;
