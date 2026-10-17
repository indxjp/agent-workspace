export type SseFrame = { event: string; id: string | null; data: unknown };

export function parseSseFrames(body: string): SseFrame[];
export function assistantText(frames: readonly { event: string; data: unknown }[]): string;
export function terminalStatus(frames: readonly { event: string; data: unknown }[]): string | null;

export type StackResponse = { status: number; headers: Headers; text: string; json: unknown };

export class StackClient {
  constructor(baseUrl: string);
  readonly baseUrl: string;
  cookie: string | null;
  request(
    route: string,
    options?: { method?: string; body?: unknown; apiKey?: string; timeoutMs?: number },
  ): Promise<StackResponse>;
  setup(body: Record<string, string>): Promise<StackResponse>;
  runFrames(runId: string, options?: { apiKey?: string; timeoutMs?: number }): Promise<SseFrame[]>;
}
