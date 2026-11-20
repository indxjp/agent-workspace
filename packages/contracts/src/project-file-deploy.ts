import { z } from 'zod';

import { API_KEY_PREFIX } from './api-keys.js';
import { VERTEX_LOCATIONS } from './models.js';
import {
  PROJECT_URL_MAX_LENGTH,
  ProjectOriginUrlSchema,
  projectResourceMap,
} from './project-file-shared.js';
import { OAUTH_CLIENT_SECRET_PREFIX } from './token-exchange.js';

/**
 * The deploy recipes a non-local environment may name (issue #621): `single-vm` is the Compose
 * project on one machine, `gcp-cloudrun` the `infra/terraform/gcp-cloudrun` module, `kubernetes`
 * the `infra/helm/agent-workspace` chart installed into the cluster the kubeconfig points at,
 * `vercel` the whole agent app as Vercel projects (ADR-0120, ADR-0126).
 */
export const PROJECT_DEPLOY_TARGETS = [
  'single-vm',
  'gcp-cloudrun',
  'kubernetes',
  'vercel',
] as const;
export type ProjectDeployTarget = (typeof PROJECT_DEPLOY_TARGETS)[number];

/** A digest-pinned image reference, `<repository>@sha256:<64 hex>`, as platform images are. */
const DIGEST_REFERENCE_PATTERN = /^[^\s@]+@sha256:[0-9a-f]{64}$/u;

/** The all-zero digest a template or a test uses as a placeholder; it names no real image. */
const PLACEHOLDER_DIGEST_SUFFIX = `@sha256:${'0'.repeat(64)}`;

/** A Secret Manager secret id: letters, digits, `-` and `_`, 1-255 characters. */
const SECRET_MANAGER_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/u;

/** A connector id as the app kit reads `AW_APP_CONNECTOR_ID`: 1-256 of letters, digits, `_-.:`. */
const APP_CONNECTOR_ID_PATTERN = /^[A-Za-z0-9_\-.:]{1,256}$/u;

/** The app keys that only the `gcp-cloudrun` target reads; see {@link ProductionAppSchema}. */
export const PRODUCTION_APP_CLOUD_RUN_KEYS = [
  'workspaceId',
  'connectorId',
  'apiKeySecret',
  'signIn',
] as const;

/**
 * Credential prefixes a Secret Manager id never starts with: an API key, an endpoint client's
 * secret, and a Google OAuth client secret (`GOCSPX-`), which the id's own pattern would admit.
 * A pasted value is refused here, before it can reach a Terraform variable or an error message.
 */
const CREDENTIAL_PREFIXES = [API_KEY_PREFIX, OAUTH_CLIENT_SECRET_PREFIX, 'GOCSPX-'] as const;

/** A Secret Manager secret id that holds a credential, never the credential itself. */
const CredentialSecretIdSchema = z
  .string()
  .regex(SECRET_MANAGER_ID_PATTERN, 'must be a Secret Manager secret id, never the value')
  .refine((id) => !CREDENTIAL_PREFIXES.some((prefix) => id.startsWith(prefix)), {
    message: 'is a credential; name the Secret Manager secret that holds it',
  });

/** An OAuth client id as the app kit reads `AW_OIDC_CLIENT_ID` and `AW_APP_CLIENT_ID`. */
const AppClientIdSchema = z.string().min(1).max(255);

/**
 * An app's sign-in on `gcp-cloudrun` (ADR-0161 DI11): the four values a production operator
 * registers, by hand, for one app. The issuer is not among them: it is always the deployment's own
 * `gcp.oidc.issuer`, the one issuer the token exchange trusts, and becomes `AW_OIDC_ISSUER_URL`.
 *
 * - `oidcClientId`: the app's own client at that issuer, the ID token's `aud`
 *   (`AW_OIDC_CLIENT_ID`); its redirect URI is the app's `<url>/api/sign-in/callback`.
 * - `oidcClientSecret`: the id of the Secret Manager secret that holds that client's secret
 *   (`AW_OIDC_CLIENT_SECRET`), never the secret.
 * - `appClientId`: the id of the app's `app-backend` endpoint client, whose `oidcAudience` is
 *   `oidcClientId` (`AW_APP_CLIENT_ID`).
 * - `appClientSecret`: the id of the Secret Manager secret that holds that endpoint client's secret
 *   (`AW_APP_CLIENT_SECRET`), never the secret.
 *
 * The four are set together: a partial sign-in would only answer `sign_in_not_configured`.
 */
export const ProductionAppSignInSchema = z
  .strictObject({
    oidcClientId: AppClientIdSchema,
    oidcClientSecret: CredentialSecretIdSchema,
    appClientId: AppClientIdSchema,
    appClientSecret: CredentialSecretIdSchema,
  })
  .readonly();
export type ProductionAppSignIn = z.infer<typeof ProductionAppSignInSchema>;

/**
 * One app the `production` environment runs beside the platform, under
 * `environments.production.apps.<name>` (issue #1512, ADR-0103's production-apps amendment): the
 * image built from the app's Next.js output, pinned by digest, and the https origin it is served
 * at. Its database schema is not a field: it is {@link appSchemaName} of the key, so it cannot
 * disagree with the schema the app kit migrates.
 *
 * {@link PRODUCTION_APP_CLOUD_RUN_KEYS} are what the app reads once its workspace exists, on
 * `gcp-cloudrun` only (the other targets refuse them at the key's path): `workspaceId` becomes the
 * app's `AW_WORKSPACE_ID`, `connectorId` its `AW_APP_CONNECTOR_ID`, and `apiKeySecret` names the
 * Secret Manager secret in the deployment's own project that holds the app's workspace API key,
 * never the key: the app's own service account may read that one secret, and the app reads it as
 * `AW_APP_API_KEY`. `signIn` ({@link ProductionAppSignInSchema}) lets people sign in to the app;
 * it needs `gcp.oidc`. A `single-vm` app takes the first three from `.env`
 * (`AW_APP_<NAME>_WORKSPACE_ID`, `_CONNECTOR_ID`, `_API_KEY`) and a `kubernetes` app from the
 * operator's Secret `agent-workspace-app-<name>`. Each is optional, so the first deploy, before
 * any workspace exists, needs none.
 */
export const ProductionAppSchema = z
  .strictObject({
    image: z
      .string()
      .max(PROJECT_URL_MAX_LENGTH, { abort: true })
      .regex(
        DIGEST_REFERENCE_PATTERN,
        'must be a sha256 digest reference, such as ghcr.io/acme/desk@sha256:…',
      )
      .refine((image) => !image.endsWith(PLACEHOLDER_DIGEST_SUFFIX), {
        message: 'must name a real image; the all-zero digest is a placeholder',
      }),
    url: ProjectOriginUrlSchema,
    workspaceId: z.uuid('must be a workspace id (a UUID)').optional(),
    connectorId: z
      .string()
      .regex(APP_CONNECTOR_ID_PATTERN, 'must be a connector id: 1-256 letters, digits, _ - . or :')
      .optional(),
    apiKeySecret: z
      .string()
      .regex(SECRET_MANAGER_ID_PATTERN, 'must be a Secret Manager secret id, never the key')
      .refine((id) => !id.startsWith(API_KEY_PREFIX), {
        message: 'is an API key; name the Secret Manager secret that holds it',
      })
      .optional(),
    signIn: ProductionAppSignInSchema.optional(),
  })
  .readonly();
export type ProductionApp = z.infer<typeof ProductionAppSchema>;

/**
 * The PostgreSQL schema an app's data lives in, which is also the name of the database role that
 * owns it in production: `app_` and the app's name key with its hyphens as underscores
 * (`service-desk` → `app_service_desk`). The app kit's `appSchemaName` derives the same name, and
 * a parity test keeps the two equal.
 */
export function appSchemaName(name: string): string {
  return `app_${name.replaceAll('-', '_')}`;
}

/**
 * The web settings a `gcp-cloudrun` project file may set on the web service, by name: documented
 * settings (`docs/40-operate/operations/settings.md`) that hold no secret. A closed list, so a project file
 * cannot reach a setting the deployment itself owns (the database, the keys, the runtime).
 */
export const PROJECT_WEB_SETTINGS = [
  'AW_DEPLOYMENT_DEFAULT_MODELS',
  'AW_DEMO_RUNS_PER_PERSON_PER_DAY',
  'AW_DEMO_RUNS_PER_CLIENT_PER_DAY',
  'AW_DEMO_MAX_TURNS_PER_RUN',
  'AW_DEMO_MAX_COST_PER_RUN_USD',
  'AW_DEMO_SITE_MAX_COST_PER_DAY_USD',
  'AW_STORE_LEAD_RETENTION_DAYS',
  'AW_EMAIL_LINK_BASE_URL',
  'AW_EMAIL_LINK_SENDER',
  'AW_EMAIL_LINK_CHALLENGE',
] as const;
export type ProjectWebSetting = (typeof PROJECT_WEB_SETTINGS)[number];

/**
 * The web settings whose value is a secret: the project file names the Secret Manager secret in
 * the deployment's own project that holds it, never the value, and the web service reads its
 * latest version. A person stores the value; nothing in the deploy prints or copies it.
 */
export const PROJECT_WEB_SECRET_SETTINGS = [
  'AW_DEMO_OPERATOR_TOKEN',
  'AW_DEMO_ANTHROPIC_API_KEY',
] as const;
export type ProjectWebSecretSetting = (typeof PROJECT_WEB_SECRET_SETTINGS)[number];

/** The most characters one web setting's value has in a project file. */
export const PROJECT_WEB_SETTING_MAX_LENGTH = 2_048;

/**
 * `environments.production.gcp`: where the `gcp-cloudrun` recipe creates its stack, in the user's
 * own Google Cloud. `project` is a project id by the rule `infra/terraform/gcp-cloudrun`'s
 * `project_id` variable applies; `region` is a region such as `asia-northeast1`. The region has no
 * default here: the module's own default stays in Terraform. `modelLocation` is where Vertex AI
 * serves the deployment's Claude models (`global`, `us` or `eu`); absent means `global`.
 *
 * Each optional key below is one Terraform variable of the module, and none holds a secret:
 * `domain` is the host name the web app is served at behind the load balancer; `armor` puts Cloud
 * Armor in front of it; `iap` puts Identity-Aware Proxy on it (it runs only with a `domain`);
 * `oidc` names the single sign-on provider, whose client secret the CLI asks for once and keeps
 * in Secret Manager, never in this file. `size` picks the D-12 preset (`small` or `standard`);
 * `dataProtection` (on by default) keeps the Cloud SQL database, the buckets and the services from
 * deletion, and `aw deploy destroy` needs it `false`, deployed first; `alertsEmail` is the address
 * alert notifications go to, and no alert policy is created without it. `sandboxInternet` adds
 * one egress-proxy VM and a Cloud NAT gateway, and enables restricted and open sandboxes on Cloud
 * Run; without it neither is created. `settings` sets {@link PROJECT_WEB_SETTINGS} on the web
 * service, and `secretSettings` maps each {@link PROJECT_WEB_SECRET_SETTINGS} name to the Secret
 * Manager secret that holds its value.
 */
export const ProductionGcpSchema = z
  .strictObject({
    project: z
      .string()
      .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'must be a Google Cloud project id'),
    region: z
      .string()
      .regex(/^[a-z]+-[a-z]+[0-9]{1,2}$/, 'must be a Google Cloud region, such as asia-northeast1'),
    domain: z
      .string()
      .max(253)
      .regex(
        /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
        'must be a lower-case host name with at least one dot, such as agents.example.com; no scheme, port or path',
      )
      .optional(),
    armor: z.boolean().optional(),
    iap: z.boolean().optional(),
    oidc: z
      .strictObject({
        issuer: z.url({ protocol: /^https$/u, error: 'must be an https:// issuer URL' }).max(2048),
        clientId: z.string().min(1).max(512),
      })
      .readonly()
      .optional(),
    modelLocation: z.enum(VERTEX_LOCATIONS).optional(),
    size: z.enum(['small', 'standard']).optional(),
    dataProtection: z.boolean().optional(),
    alertsEmail: z.email().max(254).optional(),
    sandboxInternet: z.boolean().optional(),
    settings: z
      .partialRecord(z.enum(PROJECT_WEB_SETTINGS), z.string().max(PROJECT_WEB_SETTING_MAX_LENGTH))
      .readonly()
      .optional(),
    secretSettings: z
      .partialRecord(
        z.enum(PROJECT_WEB_SECRET_SETTINGS),
        z.string().regex(SECRET_MANAGER_ID_PATTERN, 'must be a Secret Manager secret id'),
      )
      .readonly()
      .optional(),
  })
  .superRefine((gcp, context) => {
    for (const key of ['armor', 'iap'] as const) {
      if (gcp[key] === true && gcp.domain === undefined) {
        context.addIssue({ code: 'custom', path: [key], message: 'needs gcp.domain' });
      }
    }
  })
  .readonly();
export type ProductionGcp = z.infer<typeof ProductionGcpSchema>;

/**
 * An app's `signIn` needs the deployment's `gcp.oidc`: the token exchange trusts only that issuer
 * (ADR-0161), so without it the app's sign-in could never succeed.
 */
function refuseSignInWithoutIssuer(
  production: {
    readonly apps?: Readonly<Record<string, ProductionApp>> | undefined;
    readonly gcp?: ProductionGcp | undefined;
  },
  context: z.RefinementCtx<unknown>,
): void {
  if (production.gcp?.oidc !== undefined) return;
  for (const [name, app] of Object.entries(production.apps ?? {})) {
    if (app.signIn === undefined) continue;
    context.addIssue({
      code: 'custom',
      path: ['apps', name, 'signIn'],
      message:
        'needs environments.production.gcp.oidc: an app signs people in at the deployment’s own issuer',
    });
  }
}

/**
 * The `production` environment (issue #621): the deploy recipe it uses, the URL it is served at
 * and, optionally, the apps it runs beside the platform (issue #1512), keyed by app name, and the
 * Google Cloud `gcp` project and region — nothing else. Where its data lives follows from the
 * recipe; `aw deploy` turns it into the CLI's v1 profile, which stays internal. The
 * `single-vm`, `kubernetes` and `gcp-cloudrun` targets deploy `apps`; the others refuse it at
 * `environments.production.apps`. Only `gcp-cloudrun` accepts `gcp`; the others refuse it at
 * `environments.production.gcp`, and refuse an app's {@link PRODUCTION_APP_CLOUD_RUN_KEYS} at
 * `environments.production.apps.<name>.<key>`.
 */
export const ProductionEnvironmentSchema = z
  .object({
    target: z.enum(PROJECT_DEPLOY_TARGETS),
    url: ProjectOriginUrlSchema,
    apps: projectResourceMap(ProductionAppSchema).optional(),
    gcp: ProductionGcpSchema.optional(),
  })
  .strict()
  .superRefine((production, context) => {
    if (production.gcp !== undefined && production.target !== 'gcp-cloudrun') {
      context.addIssue({
        code: 'custom',
        path: ['gcp'],
        message: 'is accepted only with target: gcp-cloudrun',
      });
    }
    if (production.target === 'gcp-cloudrun') {
      refuseSignInWithoutIssuer(production, context);
      return;
    }
    for (const [name, app] of Object.entries(production.apps ?? {})) {
      for (const key of PRODUCTION_APP_CLOUD_RUN_KEYS) {
        if (app[key] === undefined) continue;
        context.addIssue({
          code: 'custom',
          path: ['apps', name, key],
          message: 'is accepted only with target: gcp-cloudrun',
        });
      }
    }
  })
  .readonly();
export type ProductionEnvironment = z.infer<typeof ProductionEnvironmentSchema>;
