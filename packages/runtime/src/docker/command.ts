import { spawn } from 'node:child_process';
import { type DockerCommand, type DockerCommandResult } from './model.js';
/** Execute Docker without a shell, preserving the argument vector byte for byte. */
export const runDockerCommand: DockerCommand = async (args, options) =>
  await new Promise<DockerCommandResult>((resolve, reject) => {
    const child = spawn('docker', [...args], { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
    child.stdin.end(options?.input);
  });

export function requireValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`docker runtime: ${name} must be a non-empty string.`);
  }
  return value;
}

export function requireSuccessful(
  result: DockerCommandResult,
  operation: string,
): DockerCommandResult {
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
    throw new Error(`docker runtime: ${operation} failed: ${detail}`);
  }
  return result;
}

export function commandFailure(error: unknown): DockerCommandResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
  };
}
