/**
 * How `agent-workspace deploy` runs the real tools (ADR-0094).
 *
 * Every tool is spawned without a shell, with its arguments as an array, so no profile value or
 * path is ever re-parsed by a shell. Output is collected rather than inherited: `deploy` prints
 * it only after the redactor has seen it, which is what keeps a `.env` secret a tool echoes out
 * of the terminal and the CI log. The runner is injected, so the suite stubs `docker`, `helm` and
 * `terraform` and never calls the real ones.
 */
import { spawn } from 'node:child_process';

/** The tools `deploy` and `publish` wrap; nothing else is ever spawned. */
export type ToolName =
  | 'docker'
  | 'helm'
  | 'terraform'
  | 'vercel'
  | 'wrangler'
  | 'ant'
  | 'atk'
  | 'agentcore'
  | 'pac'
  | 'az'
  | 'gcloud';

export interface ToolInvocation {
  readonly tool: ToolName;
  readonly args: readonly string[];
  /** Always the project directory. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Written to the tool's stdin, then closed. How a value reaches a tool without appearing in its
   * arguments, which `deploy` echoes and the process list shows.
   */
  readonly input?: string;
}

export interface ToolResult {
  /** The exit status; `null` when the process was killed by a signal. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one tool to completion. Rejects with the spawn error (`ENOENT`) when it cannot start. */
export type ToolRunner = (invocation: ToolInvocation) => Promise<ToolResult>;

export const spawnTool: ToolRunner = ({ tool, args, cwd, env, input }) => {
  const child = spawn(tool, [...args], {
    cwd,
    env,
    shell: false,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (input !== undefined) {
    // A tool that exits without reading stdin closes the pipe; its exit status says why.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status: number | null) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
};

/** True for the error a spawn of a tool that is not on `PATH` rejects with. */
export function isMissingTool(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
