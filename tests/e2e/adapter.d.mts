export interface E2EObservation {
  asserted: boolean;
  ok: boolean;
  detail: string;
  [key: string]: unknown;
}

export const loginPath: string;

export function includesDiscoveredModelConnection(body: unknown, connectionId: string): boolean;

export function streamHasSuccessfulToolExecution(text: string): boolean;

export function ready(): Promise<boolean>;

export const runners: Record<string, () => Promise<E2EObservation>>;
