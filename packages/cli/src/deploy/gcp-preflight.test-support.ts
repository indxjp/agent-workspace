import {
  REQUIRED_GCP_APIS,
  REQUIRED_GCP_PERMISSIONS,
  runGcpPreflight,
  type GcpPreflightInput,
  type GcpPreflightReport,
} from './gcp-preflight.js';
import type { ToolInvocation, ToolResult } from './runner.js';
import type { DeployContext } from './steps.js';

export const TOKEN = 'ya29.SECRET-TOKEN-VALUE';
export const PROJECT = 'acme-prod';

type Answer = ToolResult | Error;
type Answers = Readonly<Record<string, Answer>>;

export const ok = (stdout = ''): ToolResult => ({ status: 0, stdout, stderr: '' });
export const failed: ToolResult = { status: 1, stdout: '', stderr: 'boom' };
export const missingTool = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

const ALL_APIS = REQUIRED_GCP_APIS.join('\n');
const NO_POLICY = ok('{}');

export const PROJECT_NUMBER_COMMAND = `gcloud projects describe ${PROJECT} --format=value(projectNumber)`;
export const BILLING_COMMAND = `gcloud billing projects describe ${PROJECT} --format=value(billingEnabled)`;
export const SERVICES_LIST_COMMAND = `gcloud services list --enabled --project ${PROJECT} --format=value(config.name)`;
export const SERVICES_ENABLE_COMMAND = `gcloud services enable ${REQUIRED_GCP_APIS.slice(1).join(' ')} --project ${PROJECT}`;

/** The answer that leaves only `run.googleapis.com` enabled, so the other APIs are missing. */
export const ONLY_RUN_ENABLED = ok('run.googleapis.com\n');

const GREEN: Answers = {
  'gcloud --version': ok('Google Cloud SDK 500.0.0'),
  'gcloud auth application-default print-access-token': ok(TOKEN),
  'gcloud auth print-access-token': ok(TOKEN),
  [PROJECT_NUMBER_COMMAND]: ok('123456789\n'),
  [BILLING_COMMAND]: ok('True\n'),
  [SERVICES_LIST_COMMAND]: ok(ALL_APIS),
  'terraform version -json': ok(JSON.stringify({ terraform_version: '1.9.8' })),
  'docker buildx version': ok('github.com/docker/buildx v0.17.0'),
};

export function policyKey(constraint: string): string {
  return `gcloud org-policies describe ${constraint} --project ${PROJECT} --effective --format=json`;
}

export const enforcedPolicy = (): ToolResult =>
  ok(JSON.stringify({ spec: { rules: [{ enforce: true }] } }));

export const restrictedMemberDomainsPolicy = (): ToolResult =>
  ok(JSON.stringify({ spec: { rules: [{ values: { allowedValues: ['C0123'] } }] } }));

export function terraformVersion(version: string): ToolResult {
  return ok(JSON.stringify({ terraform_version: version }));
}

export interface SetupOptions {
  /** Tool answers layered over {@link GREEN}. */
  readonly overrides?: Answers;
  /** Permissions the Cloud Resource Manager reports as granted. */
  readonly granted?: readonly string[];
  readonly host?: { readonly platform: string; readonly arch: string };
  /** The Vertex rawPredict HTTP status, or the network error to raise. */
  readonly vertex?: number | Error;
  readonly modelLocation?: 'global' | 'us' | 'eu';
  readonly vertexMessage?: string;
  readonly vertexReason?: string;
}

export function requestUrl(url: Parameters<typeof fetch>[0]): string {
  return typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
}

function vertexResponse(options: SetupOptions): Promise<Response> {
  const { vertex = 200, vertexMessage = 'secret detail', vertexReason } = options;
  if (vertex instanceof Error) return Promise.reject(vertex);
  const error = {
    message: vertexMessage,
    ...(vertexReason ? { status: vertexReason } : {}),
  };
  return Promise.resolve(Response.json({ error }, { status: vertex }));
}

export function setup(options: SetupOptions = {}) {
  const { overrides = {}, granted = REQUIRED_GCP_PERMISSIONS, modelLocation } = options;
  const host = options.host ?? { platform: 'linux', arch: 'x64' };
  const answers: Answers = { ...GREEN, ...overrides };
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const context: DeployContext = {
    runner: (invocation: ToolInvocation) => {
      const line = [invocation.tool, ...invocation.args].join(' ');
      calls.push(line);
      const answer = answers[line] ?? (line.includes('org-policies') ? NO_POLICY : failed);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    directory: '/project',
    env: {},
    cloud: 'gcp',
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  const fetchStub: typeof fetch = (url, init) => {
    const target = requestUrl(url);
    requests.push({ url: target, init });
    return target.includes(':rawPredict')
      ? vertexResponse(options)
      : Promise.resolve(Response.json({ permissions: granted }));
  };
  const run = (apply = false, extra: Partial<GcpPreflightInput> = {}) =>
    runGcpPreflight({
      context,
      project: PROJECT,
      region: 'europe-west1',
      apply,
      fetch: fetchStub,
      host,
      ...(modelLocation === undefined ? {} : { modelLocation }),
      ...extra,
    });
  return { run, calls, out, err, requests };
}

export function status(report: GcpPreflightReport, id: string) {
  return report.checks.find((entry) => entry.id === id);
}

export function withoutPermission(permission: string): readonly string[] {
  return REQUIRED_GCP_PERMISSIONS.filter((granted) => granted !== permission);
}
