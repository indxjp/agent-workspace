// Types for the committed runner manager Worker golden, which `render/cloudflare.test.ts` imports.
interface FakeContainer {
  running: boolean;
  start(options: {
    entrypoint: string[];
    env: Record<string, string>;
    enableInternet: boolean;
  }): void;
  destroy(): Promise<void>;
  monitor(): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
  getTcpPort(port: number): {
    fetch(input: string | Request, init?: RequestInit): Promise<Response>;
  };
}
interface FakeState {
  container: FakeContainer | undefined;
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
export declare class Manager {
  constructor(ctx: FakeState, env: Record<string, unknown>);
  fetch(request: Request): Promise<Response>;
}
declare const worker: {
  fetch(this: void, request: Request, env: Record<string, unknown>): Promise<Response>;
};
export default worker;
