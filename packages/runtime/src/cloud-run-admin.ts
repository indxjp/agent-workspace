import {
  DEFAULT_SERVICE_TIMEOUT_SECONDS,
  type CloudRunResourceClient,
  type CloudRunServiceSpec,
  type CloudRunServiceStatus,
} from './cloud-run-contract.js';

/** Network tag the VPC firewall matches to deny sandbox egress. */
const SANDBOX_NETWORK_TAG = 'aw-sandbox';

function serviceUrl(name: string): string {
  return `https://run.googleapis.com/v2/${name}`;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toStatus(body: Record<string, unknown>): CloudRunServiceStatus {
  const condition = body['terminalCondition'] as { state?: unknown } | undefined;
  const template = body['template'] as
    { containers?: { env?: { name?: unknown; value?: unknown }[] }[] } | undefined;
  const intakeKey = template?.containers?.[0]?.env?.find(
    (entry) => entry.name === 'AW_TOOL_INTAKE_KEY',
  )?.value;
  const rawLabels = body['labels'];
  const labels: Record<string, string> = {};
  if (typeof rawLabels === 'object' && rawLabels !== null) {
    for (const [key, value] of Object.entries(rawLabels)) {
      if (typeof value === 'string') labels[key] = value;
    }
  }
  return {
    name: stringField(body['name']),
    url: stringField(body['uri']),
    ready: condition?.state === 'CONDITION_SUCCEEDED',
    labels,
    ...(typeof intakeKey === 'string' ? { intakeKey } : {}),
  };
}

function serviceRequestBody(spec: CloudRunServiceSpec) {
  return {
    labels: spec.labels,
    ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
    template: {
      serviceAccount: spec.serviceAccount,
      timeout: `${String(spec.timeoutSeconds ?? DEFAULT_SERVICE_TIMEOUT_SECONDS)}s`,
      executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
      maxInstanceRequestConcurrency: spec.maxRequestConcurrency ?? 1,
      scaling: { minInstanceCount: spec.minInstances ?? 0, maxInstanceCount: 1 },
      vpcAccess: {
        networkInterfaces: [
          {
            network: spec.network,
            subnetwork: spec.subnetwork,
            tags: [SANDBOX_NETWORK_TAG],
          },
        ],
        egress: 'ALL_TRAFFIC',
      },
      containers: [
        {
          image: spec.image,
          ports: [{ containerPort: 8080 }],
          ...(spec.env === undefined || Object.keys(spec.env).length === 0
            ? {}
            : {
                env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
              }),
          // /ping, never /healthz: Google's edge reserves /healthz (see the ADR).
          // 2 s x 50 attempts stays under the driver's 120 s readyTimeoutMs.
          startupProbe: {
            httpGet: { path: '/ping', port: 8080 },
            periodSeconds: 2,
            failureThreshold: 50,
            timeoutSeconds: 1,
          },
          resources: {
            limits: {
              cpu: String(spec.cpu ?? 1),
              memory: `${String(spec.memoryMb ?? 1024)}Mi`,
            },
          },
        },
      ],
    },
  };
}

async function listRegionalServices(
  authorizedFetch: (url: string, init?: RequestInit) => Promise<Response>,
  scope: { readonly project: string; readonly region: string },
): Promise<readonly CloudRunServiceStatus[]> {
  const { project, region } = scope;
  const found: CloudRunServiceStatus[] = [];
  let pageToken = '';
  do {
    const response = await authorizedFetch(
      `${serviceUrl(`projects/${project}/locations/${region}/services`)}?pageSize=200${pageToken === '' ? '' : `&pageToken=${encodeURIComponent(pageToken)}`}`,
    );
    if (!response.ok) {
      throw new Error(
        `cloud-run runtime: list services failed: ${String(response.status)} ${await response.text()}`,
      );
    }
    const page = (await response.json()) as { services?: unknown; nextPageToken?: unknown };
    for (const service of Array.isArray(page.services) ? page.services : []) {
      found.push(toStatus(service as Record<string, unknown>));
    }
    pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : '';
  } while (pageToken !== '');
  return found;
}

/** Cloud Run v2 REST client, authenticated with Application Default Credentials. */
export function createCloudRunAdminClient(options: {
  fetch?: typeof globalThis.fetch;
  accessToken: () => Promise<string>;
}): CloudRunResourceClient {
  const doFetch = options.fetch ?? globalThis.fetch;

  async function authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await options.accessToken();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('content-type', 'application/json');
    return await doFetch(url, { ...init, headers });
  }

  return {
    async createService(spec) {
      const parent = `projects/${spec.project}/locations/${spec.region}`;
      const response = await authorizedFetch(
        `https://run.googleapis.com/v2/${parent}/services?serviceId=${spec.serviceId}`,
        {
          method: 'POST',
          body: JSON.stringify(serviceRequestBody(spec)),
        },
      );
      if (!response.ok) {
        throw new Error(
          `cloud-run runtime: create service ${spec.serviceId} failed: ${String(response.status)} ${await response.text()}`,
        );
      }
      const operation = (await response.json()) as { metadata?: { name?: unknown } };
      const name =
        typeof operation.metadata?.name === 'string'
          ? operation.metadata.name
          : `${parent}/services/${spec.serviceId}`;
      return { name, url: '', ready: false };
    },

    async getService(name) {
      const response = await authorizedFetch(serviceUrl(name));
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(
          `cloud-run runtime: get service ${name} failed: ${String(response.status)} ${await response.text()}`,
        );
      }
      return toStatus((await response.json()) as Record<string, unknown>);
    },

    async listServices(project, region) {
      return listRegionalServices(authorizedFetch, { project, region });
    },

    async deleteService(name) {
      const response = await authorizedFetch(serviceUrl(name), { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new Error(
          `cloud-run runtime: delete service ${name} failed: ${String(response.status)} ${await response.text()}`,
        );
      }
    },
  };
}
