import { z } from 'zod';

import { ConnectorIdentitySchema } from './identity-assertion.js';
import {
  MODEL_CONNECTION_CONFIG_FIELDS,
  MODEL_PROVIDER_CONFIG_RULES,
  type ModelConnectionConfigField,
  isKeylessProvider,
} from './models.js';
import { ProjectHttpUrlSchema } from './project-file-shared.js';
import { MODEL_PROVIDERS } from './runs.js';
import { SecretReferenceSchema } from './secret-reference.js';

/** The longest Azure `deployment` or `apiVersion` a project file may name, in characters. */
const PROJECT_CONFIG_TEXT_MAX_LENGTH = 200;

/** The settings a project file can carry: the keyless provider's `projectId` and `location` are not among them. */
export const PROJECT_FILE_CONFIG_FIELDS = MODEL_CONNECTION_CONFIG_FIELDS.filter(
  (field): field is Exclude<ModelConnectionConfigField, 'projectId' | 'location'> =>
    field !== 'projectId' && field !== 'location',
);

/**
 * One model connection a project file declares under `models.<name>` (C10, C11, issue #524):
 * the provider, the credential as a secret reference, and the provider's settings. Which settings
 * a provider accepts and requires is `MODEL_PROVIDER_CONFIG_RULES`, the server's own table: each
 * setting it does not accept, and each it requires that is missing, is refused at the setting's
 * own path (`models.<name>.deployment`).
 *
 * A connection carries no model id (C11), so a `model` key is refused at its path; an agent names
 * its model.
 */
export const ProjectModelConnectionSchema = z
  .object({
    provider: z.enum(MODEL_PROVIDERS).refine((provider) => !isKeylessProvider(provider), {
      error: 'is set up by aw deploy for gcp-cloudrun, not in the project file',
    }),
    credential: SecretReferenceSchema,
    baseUrl: ProjectHttpUrlSchema.optional(),
    deployment: z.string().min(1).max(PROJECT_CONFIG_TEXT_MAX_LENGTH).optional(),
    apiVersion: z.string().min(1).max(PROJECT_CONFIG_TEXT_MAX_LENGTH).optional(),
    model: z
      .never({ error: 'a model connection carries no model id (C11); name the model in an agent' })
      .optional(),
  })
  .strict()
  .superRefine((connection, context) => {
    const rule = MODEL_PROVIDER_CONFIG_RULES[connection.provider];
    for (const field of PROJECT_FILE_CONFIG_FIELDS) {
      const present = connection[field] !== undefined;
      if (present && !rule.allowed.includes(field)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `is not accepted for provider ${connection.provider}`,
        });
      }
      if (!present && rule.required.includes(field)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `is required for provider ${connection.provider}`,
        });
      }
    }
  })
  .readonly();
export type ProjectModelConnection = z.infer<typeof ProjectModelConnectionSchema>;

/** The transports a project file's connector may use; an absent `transport` means `http`. */
export const PROJECT_CONNECTOR_TRANSPORTS = ['http', 'sse'] as const;
export type ProjectConnectorTransport = (typeof PROJECT_CONNECTOR_TRANSPORTS)[number];

/** The authentication schemes a project file's connector may name (issue #524). */
export const PROJECT_CONNECTOR_AUTH_SCHEMES = ['bearer', 'api-key'] as const;
export type ProjectConnectorAuthScheme = (typeof PROJECT_CONNECTOR_AUTH_SCHEMES)[number];

/**
 * One MCP connector a project file declares under `connectors.<name>` (C10, issue #524): its
 * `http(s)` URL, its transport, and optionally its credential as a secret reference. An absent
 * `transport` means `http`; the schema records that in this comment rather than transforming the
 * value, so the editor schema stays exact. A `stdio` connector is refused: a project file names
 * only remote connectors.
 */
export const ProjectConnectorSchema = z
  .object({
    url: ProjectHttpUrlSchema,
    transport: z
      .enum(PROJECT_CONNECTOR_TRANSPORTS, {
        error: 'must be http or sse; a stdio connector is not supported in a project file',
      })
      .optional(),
    auth: z
      .object({
        scheme: z.enum(PROJECT_CONNECTOR_AUTH_SCHEMES),
        credential: SecretReferenceSchema,
      })
      .strict()
      .readonly()
      .optional(),
    /** Opt in to the signed identity assertion (ADR-0142 D1); the server reads the named secret at run compose. */
    identity: ConnectorIdentitySchema.optional(),
  })
  .strict()
  .readonly();
export type ProjectConnector = z.infer<typeof ProjectConnectorSchema>;
