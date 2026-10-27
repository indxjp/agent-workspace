import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { TOOL_BUNDLE_TIMEOUT_MAX_MS } from '@indx-workspace/contracts/agent-versions';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PROJECT_FILE_NAME } from '@indx-workspace/sdk/project';
import { z } from 'zod';

import { command, type LocalCommand, type LocalCommandContext } from '../command.js';
import { CommandRefusedError, UsageError } from '../io.js';
import { readLocalProject } from '../local-runtime/project.js';
import { startToolHost } from '../tools/host.js';

const ToolInputSchema = z.record(z.string(), z.unknown());

const ToolResultSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
});

/** The run id a tool sees when `aw tool call` runs it: there is no run. */
const LOCAL_RUN_ID = 'local';

/** `--input '<json>'`, `--input -` for stdin, or `{}` when absent. */
async function inputOf(context: LocalCommandContext): Promise<Record<string, unknown>> {
  const given = context.args.values.get('input');
  if (given === undefined) return {};
  const text = given === '-' ? await context.readStdin() : given;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = ToolInputSchema.safeParse(json);
  if (!parsed.success) throw new UsageError('--input must be a JSON object');
  return parsed.data;
}

async function callTool(context: LocalCommandContext): Promise<void> {
  const { cwd, io, signal } = context;
  const name = context.positionals[0];
  if (name === undefined) throw new UsageError('missing <name>');
  if (name.trim() === '') throw new UsageError('<name> must not be empty');
  const input = await inputOf(context);
  if (cwd === undefined || (await readLocalProject(cwd)) === null) {
    throw new CommandRefusedError(`no ${PROJECT_FILE_NAME} in this directory`, 'aw init --yes');
  }
  const lifetime = new AbortController();
  const host = await startToolHost({
    root: cwd,
    io,
    signal: AbortSignal.any([signal, lifetime.signal]),
  });
  try {
    if (!host.tools().includes(name)) {
      const served = host.tools();
      // BH061-048: a file name is not a tool name; say so when one was given.
      const file = (await readdir(path.join(cwd, 'tools')).catch(() => [])).find(
        (entry) => entry.replace(/\.[cm]?[jt]s$/u, '') === name,
      );
      throw new CommandRefusedError(
        `no tool named ${name} in tools/` +
          (file === undefined
            ? ''
            : ` (tools/${file} is a file; call a tool by the name its defineTool() gives it)`),
        served.length === 0
          ? 'add a tool with defineTool() under tools/'
          : `the tools served are: ${served.join(', ')}`,
      );
    }
    const client = new Client({ name: 'aw-tool-call', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.url), {
        requestInit: { headers: { 'x-aw-run-id': LOCAL_RUN_ID } },
      }),
    );
    let result: z.infer<typeof ToolResultSchema>;
    try {
      result = ToolResultSchema.parse(
        await client.callTool({ name, arguments: input }, undefined, {
          signal,
          // The host enforces the tool's own limit; this one only has to outlast the largest.
          timeout: TOOL_BUNDLE_TIMEOUT_MAX_MS + 10_000,
        }),
      );
    } finally {
      await client.close();
    }
    if (context.mode.jsonl) io.stdout(`${JSON.stringify(result)}\n`);
    else if (context.mode.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const part of result.content) {
        io.stdout(`${part.text ?? JSON.stringify(part)}\n`);
      }
    }
    if (result.isError === true) throw new CommandRefusedError(`tool ${name} reported an error`);
  } finally {
    lifetime.abort();
    await host.closed;
  }
}

/** `aw tool call` (issue #800): one code tool through the same host `aw dev` starts. */
export const toolCommands: readonly LocalCommand[] = [
  command(
    'tool call',
    '<name> [--input <json>|-] [--json|--jsonl]',
    'Run one code tool from tools/ through the local tool host and print its result',
    { controlPlane: 'none', run: callTool },
  ),
];
