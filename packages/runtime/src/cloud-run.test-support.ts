import { createCloudRunDriver } from './cloud-run.js';
import type { CloudRunResourceClient, CloudRunServiceSpec } from './cloud-run.js';

type CloudRunDriverOptions = Parameters<typeof createCloudRunDriver<string, string>>[0];

type CloudRunToolOverrides = Partial<CloudRunDriverOptions> &
  Required<Pick<CloudRunDriverOptions, 'fileIntake'>>;

/** A driver over `client` with the standard test project, region, image and instant polling. */
export function cloudRunDriver(
  client: CloudRunResourceClient,
  overrides: Partial<CloudRunDriverOptions> = {},
) {
  return createCloudRunDriver<string, string>(standardOptions(client, overrides));
}

/** As `cloudRunDriver`, for the file-intake variant that can find and destroy tagged services. */
export function cloudRunToolDriver(
  client: CloudRunResourceClient,
  overrides: CloudRunToolOverrides,
) {
  return createCloudRunDriver<string, string>({
    ...standardOptions(client, overrides),
    fileIntake: overrides.fileIntake,
  });
}

function standardOptions(
  client: CloudRunResourceClient,
  overrides: Partial<CloudRunDriverOptions>,
): CloudRunDriverOptions {
  return {
    images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
    project: 'proj',
    region: 'asia-northeast1',
    serviceAccount: 'runtime-sa@proj.iam.gserviceaccount.com',
    ...NET,
    client,
    pollIntervalMs: 0,
    startAgent: () => echoConnection('unused'),
    ...overrides,
  };
}

export const NET = {
  network: 'projects/proj/global/networks/aw',
  subnetwork: 'projects/proj/regions/r/subnetworks/aw-sandbox',
};

export function echoConnection(value: string) {
  return {
    events: (async function* () {
      await Promise.resolve();
      yield value;
    })(),
    sessionId: Promise.resolve('session'),
    interrupt: () => Promise.resolve(),
  };
}

export function fakeClient(): {
  client: CloudRunResourceClient;
  created: string[];
  deleted: string[];
  specs: CloudRunServiceSpec[];
} {
  const specs: CloudRunServiceSpec[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  const services = new Map<string, { ready: boolean; url: string }>();
  const client: CloudRunResourceClient = {
    createService: (spec) => {
      specs.push(spec);
      const name = `projects/${spec.project}/locations/${spec.region}/services/${spec.serviceId}`;
      created.push(name);
      services.set(name, { ready: false, url: '' });
      return Promise.resolve({ name, url: '', ready: false });
    },
    getService: (name) => {
      const known = services.get(name);
      if (known === undefined) return Promise.resolve(null);
      // First poll after creation reports ready, mimicking a fast-converging revision.
      const ready = { ready: true, url: `https://${name.split('/').pop()}.a.run.app` };
      services.set(name, ready);
      return Promise.resolve({ name, ...ready });
    },
    deleteService: (name) => {
      deleted.push(name);
      services.delete(name);
      return Promise.resolve();
    },
    listServices: () =>
      Promise.resolve(
        specs
          .map((spec) => ({
            name: `projects/${spec.project}/locations/${spec.region}/services/${spec.serviceId}`,
            url: `https://${spec.serviceId}.a.run.app`,
            ready: true,
            labels: spec.labels,
            ...(spec.env?.['AW_TOOL_INTAKE_KEY'] === undefined
              ? {}
              : { intakeKey: spec.env['AW_TOOL_INTAKE_KEY'] }),
          }))
          .filter((service) => services.has(service.name)),
      ),
  };
  return { client, created, deleted, specs };
}
