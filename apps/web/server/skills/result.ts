import type { ApiResult } from '../http/result';

export { problem, type ApiProblem } from '../http/result';

export function json(status: number, body: unknown): ApiResult {
  return { status, body };
}
