import { z } from 'zod';

const PermissionPolicySchema = z.enum(['always_allow', 'always_ask', 'auto']);

/** `extensions.platforms['claude-managed-agents']` of the root agent. */
export const ClaudeManagedAgentsOptionsSchema = z
  .strictObject({
    /** Overrides PortableAgent.model.id for every emitted agent; must be a claude-* id. */
    model: z
      .strictObject({
        id: z
          .string()
          .regex(/^claude-[a-z0-9-]+$/u)
          .optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
        inferenceGeo: z.enum(['us', 'global']).optional(),
      })
      .optional(),
    /** Hosts added to the environment's limited allowlist (bare host or *.suffix). */
    allowedHosts: z
      .array(z.string().regex(/^(\*\.)?[a-z0-9.-]+$/u))
      .max(256)
      .optional(),
    /** Pre-installed packages, passed through to environment config.packages. */
    packages: z
      .strictObject({
        apt: z.array(z.string()).optional(),
        cargo: z.array(z.string()).optional(),
        gem: z.array(z.string()).optional(),
        go: z.array(z.string()).optional(),
        npm: z.array(z.string()).optional(),
        pip: z.array(z.string()).optional(),
      })
      .optional(),
    /** permission_policy for every emitted mcp_toolset; left out, the vendor default always_ask. */
    mcpPermissionPolicy: PermissionPolicySchema.optional(),
    /** permission_policy for the built-in toolset; left out, the vendor default always_allow. */
    toolsetPermissionPolicy: PermissionPolicySchema.optional(),
  })
  .readonly();
export type ClaudeManagedAgentsOptions = z.infer<typeof ClaudeManagedAgentsOptionsSchema>;
