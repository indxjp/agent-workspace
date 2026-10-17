export const EXPECTED_STEP_COUNT: 11;
export const GATEWAY_CREDENTIAL_BOUND_STEPS: ReadonlySet<string>;

export type Observation = {
  asserted?: boolean;
  ok?: boolean;
  status?: number;
  code?: string;
  detail?: string;
};

export type FlowResult = {
  id: string;
  status: 'passed' | 'failed' | 'credential-bound';
  detail: string;
  loginPath?: 'oidc' | 'bootstrap-administrator';
};

export type StepRunner = (context: {
  index: number;
  previous: FlowResult[];
}) => Observation | Promise<Observation>;

export class SpecFlowError extends Error {
  readonly code: string;
}

export function parsePrimaryFlow(source: string): string[];
export function readPrimaryFlow(specUrl?: URL): Promise<string[]>;
export function isGatewayUnauthenticated(observation: unknown): boolean;
export function classifyObservation(step: string, observation?: Observation): FlowResult['status'];
export function runPrimaryFlow(input: {
  steps: string[];
  runners: Record<string, StepRunner>;
  loginPath: 'oidc' | 'bootstrap-administrator';
}): Promise<FlowResult[]>;
