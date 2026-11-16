// `starterFor` checks the starters root with `node:fs` (typed by `node-fs.d.ts`): `./project` is the
// Node-side subpath, used by aw and create, and this package carries no Node types.
import { statSync } from 'node:fs';

import { type HostedPlatformId } from '@indx-workspace/contracts/platforms';

import { toolIdentifier } from './setup-tools.js';
import { renderTemplateDirectory, type ProjectFile } from './template.js';

/**
 * `AGENTS.md`: how a coding agent runs this project with no terminal to answer prompts. Short, and
 * it names the variables `aw dev` reads (the model key and any tool secret) but never a value.
 */
export function agentsFile(
  secrets: readonly string[],
  platforms: readonly HostedPlatformId[],
): string {
  const [keyVariable = '', ...toolSecrets] = secrets;
  const list = secrets.map((name) => `\`${name}\``).join(', ');
  return `# Running this project (for coding agents)

Run these in the project directory. Nothing here asks a question.

1. \`npm install\`
2. Start the runtime in the background, its screen going to \`.aw/dev.out\`; \`npm run dev\` does not
   exit, so never run it in the foreground. Set the variables from "Keys" in the same command
   (a tool call may start a fresh shell), before the start. Append to the log (\`>>\`): truncating it blanks a running start's screen.
   - Linux and WSL: \`mkdir -p .aw && setsid npm run dev >> .aw/dev.out 2>&1 < /dev/null &\`
     (\`setsid\` keeps it running when the shell or session ends)
   - macOS: \`mkdir -p .aw && nohup npm run dev >> .aw/dev.out 2>&1 < /dev/null &\`
   - PowerShell: \`New-Item -ItemType Directory -Force .aw | Out-Null; Start-Process npm.cmd -ArgumentList 'run','dev' -WindowStyle Hidden -RedirectStandardOutput .aw/dev.out -RedirectStandardError .aw/dev.err\`
3. Wait until \`npx aw dev status\` exits 0: it prints the URL once the runtime is ready (add
   \`--json\` for \`{"running":true,"url":…}\`). The ready screen is in \`.aw/dev.out\` (its \`try\`
   row is the URL, normally \`http://127.0.0.1:3000/p/s/main/try\`); the runtime's own log is
   \`.aw/logs/runtime.log\`. Stop it with \`npx aw dev stop\`, never by killing \`npm\`.
4. Check it works: \`npx aw chat -p "hi"\` answers, or open the try URL. Report the try URL.

## Keys

\`aw dev\` reads ${list} from its environment: \`${keyVariable}\` is the model key${
    toolSecrets.length === 0 ? '' : ', the others are tool secrets'
  }. Ask the user for any value you do not have, or ask them to set it in the shell that launches
you.

- bash/zsh (the user types it, not echoed): \`read -rs ${keyVariable} && export ${keyVariable}\`
- PowerShell: \`$env:${keyVariable} = '<your key>'\`

Never write a key into a file, and never commit one. Before committing, make sure \`.gitignore\`
lists \`.env\` and \`.aw/\`, and add them if it does not.

Edit \`agents/\` and \`surfaces/\`; each save syncs by itself while \`npm run dev\` runs.
${platforms.length === 0 ? '' : agentsPlatformsSection(platforms)}`;
}

/** The `AGENTS.md` section that tells a coding agent how to check and publish to other platforms. */
function agentsPlatformsSection(platforms: readonly HostedPlatformId[]): string {
  return `
## Other agent platforms

\`agent-workspace.yaml\` names the platforms this agent is published to under \`platforms:\`
(${platforms.join(', ')}). Before publishing, check what each keeps:
\`npx aw platforms export --platform <id> --strict\`; exit 5 means a field would be dropped, and
\`PLATFORM_REPORT.md\` says which and why. Publish only when the user asks:
\`npx aw platforms publish --platform <id>\` shows the plan, and \`--yes\` applies it with the user's
own vendor login. Never put a credential on the command line or in a file.
`;
}

/** The `README.md` section that hands the developer the `aw platforms` commands for the chosen platforms. */
function readmePlatformsSection(agentName: string, platforms: readonly HostedPlatformId[]): string {
  const width = Math.max(...platforms.map((id) => id.length));
  const commentColumn = 'npx aw platforms publish --platform '.length + width + 3;
  const pairs = platforms.flatMap((id) => [
    `npx aw platforms export --platform ${id.padEnd(width)}    # writes platforms/${id}/ and PLATFORM_REPORT.md; sends nothing`,
    `npx aw platforms publish --platform ${id.padEnd(width)}   # shows the plan; add --yes to publish with your own vendor login`,
  ]);
  const doctor = `${'npx aw platforms doctor'.padEnd(commentColumn)}# checks every enabled platform and its vendor CLI`;
  return `## Publish to other agent platforms

\`agent-workspace.yaml\` lists the platforms this agent is published to under \`platforms:\`.
\`agents/${agentName}.ts\` stays the one definition; each command translates it.

\`\`\`sh
${[...pairs, doctor].join('\n')}
\`\`\`

What a platform cannot run is listed as dropped in \`PLATFORM_REPORT.md\`, never left out silently;
add \`--strict\` to \`export\` to fail instead.
`;
}

/** Appends the platforms section to the starter's `README.md`, or adds a `README.md` when it has none. */
export function withPlatformsReadme(
  files: readonly ProjectFile[],
  agentName: string,
  platforms: readonly HostedPlatformId[],
): readonly ProjectFile[] {
  const section = readmePlatformsSection(agentName, platforms);
  if (!files.some((file) => file.path === 'README.md')) {
    return [...files, { path: 'README.md', contents: `# ${agentName}\n\n${section}` }];
  }
  return files.map((file) =>
    file.path === 'README.md' ? { ...file, contents: `${file.contents}\n${section}` } : file,
  );
}

/** The starter files of `theme`, and the identifiers of the tools in them. */
interface Starter {
  readonly files: readonly ProjectFile[];
  readonly tools: readonly { readonly name: string; readonly identifier: string }[];
}

/**
 * The files kept under `starters/<theme>/` (real files, so they are type-checked and linted like
 * code; the build copies them beside this module), rendered by `renderTemplateDirectory` with two
 * values: `agentName`, the agent's name, and `version`, the exact version the project's packages are
 * pinned to (`renderProjectShell`'s). A starter that uses `{{version}}` when there is none is
 * refused. Every rendered `tools/<name>.ts` that is not a run file is a tool the agent imports. A
 * theme with no directory has no starter.
 */
export function starterFor(theme: string, agentName: string, version: string | undefined): Starter {
  // A missing starters root is a broken package (a build that skipped the copy): let it throw.
  statSync(new URL('./starters/', import.meta.url));
  // Only a theme with no directory under an existing starters root has no starter.
  const files = renderTemplateDirectory(
    new URL(`./starters/${theme}/`, import.meta.url),
    { agentName, ...(version === undefined ? {} : { version }) },
    'the project',
    {
      optional: true,
      missingMessage: () => `is required: the ${theme} starter pins packages to it`,
    },
  );
  const tools = files
    .map((file) => /^tools\/([^/]+)\.ts$/u.exec(file.path)?.[1])
    .filter((name): name is string => name !== undefined && !name.endsWith('.run'))
    .map((name) => ({ name, identifier: toolIdentifier(name) }));
  return { files, tools };
}
