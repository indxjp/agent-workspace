import { z } from 'zod';

const HttpsUrlSchema = z.url({ protocol: /^https$/u });

/**
 * `extensions.platforms['m365-declarative-agent']`. The last four fields carry the Microsoft
 * 365-only settings that a portable agent has no field for, so they survive an import and export.
 */
export const M365DeclarativeAgentOptionsSchema = z
  .strictObject({
    /** The app package version; semver. */
    appVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/u)
      .default('1.0.0'),
    /** Written literally; absent, `manifest.json` carries `${{DEVELOPER_*}}` placeholders that `env/.env.dev` lists. */
    developer: z
      .strictObject({
        name: z.string().min(1).max(32),
        websiteUrl: HttpsUrlSchema,
        privacyUrl: HttpsUrlSchema,
        termsOfUseUrl: HttpsUrlSchema,
      })
      .optional(),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/u)
      .default('#5B5FC7'),
    conversationStarters: z
      .array(z.strictObject({ title: z.string().min(1).optional(), text: z.string().min(1) }))
      .max(12)
      .optional(),
    disclaimer: z.string().trim().min(1).max(500).optional(),
    defaultResponseMode: z.enum(['Auto', 'Quick response', 'Think deeper']).optional(),
    discourageModelKnowledge: z.boolean().optional(),
  })
  .readonly();
export type M365DeclarativeAgentOptions = z.infer<typeof M365DeclarativeAgentOptionsSchema>;
