import { z } from 'zod';

/** `extensions.platforms['copilot-studio']` of the root agent. */
export const CopilotStudioOptionsSchema = z.strictObject({
  /** Dataverse publisher customization prefix; `pac copilot init|pack --publisher-prefix`. */
  // VERIFY rule: Learn "publisher prefix" (2-8 characters)
  publisherPrefix: z.string().regex(/^[a-z][a-z0-9]{1,7}$/u),
  /** Agent schema name; default `${publisherPrefix}_${camelCase(root.name)}` (pac init's derivation). */
  schemaName: z
    .string()
    .regex(/^[a-z][a-z0-9]{1,7}_[A-Za-z][A-Za-z0-9]{0,63}$/u)
    .optional(),
  /** Pins the primary model; left out, the environment's default model is used. */
  modelNameHint: z.string().min(1).max(100).optional(),
  /** Whose credentials MCP connections use. Maker = one service credential (matches a secretRef). */
  mcpConnectionMode: z.enum(['Maker', 'Invoker']).default('Maker'),
  /** Primary language LCID; settings.mcs.yml `language`. */
  language: z.number().int().positive().default(1033),
  conversationStarters: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(100),
        text: z.string().min(1).max(1000),
      }),
    )
    .max(12)
    .optional(),
  /** Topic passthrough: file stem → complete topic YAML text, emitted verbatim as agent/topics/<stem>.mcs.yml. */
  topics: z
    .record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u), z.string().min(1).max(256_000))
    .optional(),
});
export type CopilotStudioOptions = z.output<typeof CopilotStudioOptionsSchema>;
