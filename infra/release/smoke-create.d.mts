export type ProbeState = 'published' | 'unpublished' | 'not-public' | 'not-found' | 'unreachable';
export type Io = {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<unknown>;
};

export const REQUEST_TIMEOUT_MS: number;
export const ATTEMPTS: number;
export class RegistryUnreachable extends Error {}

export function smokeDecision(states: readonly ProbeState[]): 'run' | 'skip' | 'fail';
export function bearerChallenge(header: string): Record<string, string>;
export function fetchWithRetry(url: string | URL, init: RequestInit, io?: Io): Promise<Response>;
export function probeImage(
  registry: string,
  repository: string,
  tag: string,
  io?: Io,
): Promise<{ state: ProbeState; detail?: string }>;
export function githubOwnerExists(owner: string, io?: Io): Promise<boolean>;
