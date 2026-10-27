import { access, readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { PUBLISHED_PACKAGES } from '../scripts/release/pack-packages.mjs';

const repository = new URL('../', import.meta.url);

describe('current public documentation follows executable truth', () => {
  it('does not retain superseded setup, storage, or runtime claims', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).not.toContain('Administrator and agent submission remain unavailable');
    expect(readme).not.toContain('zero-infrastructure start command creates embedded PostgreSQL');
    expect(readme).toContain('local driver is for development only');
    expect(readme).toContain('seeded bootstrap administrator');
    expect(readme).not.toContain('reserved by unrelated npm publishers');
    expect(readme).toContain('npm create @indx-workspace@latest my-agent-platform');
    expect(readme).toContain('npx -p @indx-workspace/cli create-agent-workspace my-agent-platform');
    expect(readme).toContain('npx @indx-workspace/aw me');
  });

  it('documents /signin, when the provider key is checked, and teardown in the self-hosting guide', async () => {
    const page = (
      await readFile(new URL('../docs/sdk/site/building/self-hosting.mdx', import.meta.url), 'utf8')
    ).replace(/\s+/gu, ' ');
    expect(page).toContain('open `/signin`');
    expect(page).toContain('only at step 4');
    expect(page).toContain('which is checked when you click "Finish setup"');
    expect(page).toContain('`pnpm stop` (`agent-workspace stop`)');
    expect(page).toContain('add `--volumes`');
  });

  // Issue #416: first-run polish from the 0.2.0 verification.
  it('shows a complete agent.json, names the setup password, and notes mirrored WSL ports', async () => {
    const read = async (relative: string) =>
      (await readFile(new URL(relative, repository), 'utf8')).replace(/\s+/gu, ' ');
    const cli = await read('docs/sdk/site/cli/overview.mdx');
    const selfHosting = await read('docs/sdk/site/building/self-hosting.mdx');
    expect(cli).toContain('"modelConnectionId": null');
    expect(cli).toContain('"model": null');
    for (const permission of ['readFiles', 'writeFiles', 'runCommands', 'unrestrictedNetwork']) {
      expect(cli).toContain(`"${permission}":`);
    }
    expect(cli).toContain('cannot run until it has a runtime profile and a model');
    expect(selfHosting).toContain('`BOOTSTRAP_ADMIN_PASSWORD`');
    expect(selfHosting).toContain('"One-time setup password" the generator printed');
    expect(selfHosting).toContain('mirrored networking');
    expect(selfHosting).toContain('may be a Windows process');
  });

  /**
   * Two separate version lines. The platform release (root `package.json`) is what the evidence
   * manifest records. The five published `@indx-workspace` packages are lock-step at
   * `CONTRACTS_VERSION` (ADR-0082 D3) and take patch releases of their own, so they are held to
   * that constant rather than to the platform version.
   */
  it('keeps release/package versions aligned without claiming package ownership', async () => {
    const manifest = async (path: string) =>
      JSON.parse(await readFile(new URL(path, repository), 'utf8')) as {
        name: string;
        version: string;
      };
    const root = await manifest('package.json');
    const evidence = JSON.parse(
      await readFile(new URL('../docs/release/evidence-manifest.json', import.meta.url), 'utf8'),
    ) as {
      releaseVersion: string;
      artifacts: { package: { version: string; ownershipVerified: boolean } };
    };
    expect(evidence.releaseVersion).toBe(root.version);
    expect(evidence.artifacts.package.version).toBe(root.version);
    expect(evidence.artifacts.package.ownershipVerified).toBe(false);

    const { CONTRACTS_VERSION } = await import('@indx-workspace/contracts');
    for (const name of PUBLISHED_PACKAGES) {
      const published = await manifest(`packages/${name}/package.json`);
      expect(published.name).toBe(`@indx-workspace/${name}`);
      expect(published.version, published.name).toBe(CONTRACTS_VERSION);
    }
  });

  it('links to shipped agent-detail and Terraform entry points', async () => {
    await Promise.all([
      access(new URL('../apps/web/app/(shell)/agents/[id]/page.tsx', import.meta.url)),
      access(new URL('../infra/terraform/gcp-small/README.md', import.meta.url)),
    ]);
  });

  it('keeps runnable public execution compiled fail-closed for D-06', async () => {
    const feature = await import('../apps/web/server/shares/runnable/feature.js');
    expect(feature.runnablePublicLinksEnabled({ AW_ENABLE_RUNNABLE_PUBLIC_LINKS: 'true' })).toBe(
      false,
    );
  });

  it('keeps the capability ledger and evidence manifest on their enforced schemas', async () => {
    const status = JSON.parse(
      await readFile(new URL('../docs/capabilities/status.json', import.meta.url), 'utf8'),
    ) as { schemaVersion: number; releaseEvidenceManifest: string };
    expect(status.schemaVersion).toBe(2);
    expect(status.releaseEvidenceManifest).toBe('docs/release/evidence-manifest.json');
    await access(new URL(status.releaseEvidenceManifest, repository));
  });

  // Issue #458 (S1-20): the slice-1 docs describe what main does, and nothing more.
  it('describes the aw dev path as main runs it and what the journey job proves', async () => {
    const read = async (relative: string) =>
      (await readFile(new URL(relative, repository), 'utf8')).replace(/\s+/gu, ' ');
    const quickstart = await read('docs/sdk/site/getting-started/quickstart.mdx');
    const selfHosting = await read('docs/sdk/site/building/self-hosting.mdx');
    const developers = await read('ui/developers.html');
    const readme = await read('README.md');

    // The generated project sets no runtime.default, so the Runtime: line names the host's driver,
    // but runs on the `local` profile use the in-process `local` driver (no isolation) regardless,
    // so no image is pulled on that path.
    for (const page of [quickstart, developers]) {
      expect(page).not.toContain('starts the runtime on the `local` driver');
      expect(page).not.toContain('on the <code>local</code> runtime driver');
    }
    for (const page of [quickstart, selfHosting, developers]) {
      expect(page).not.toMatch(/may pull images/u);
    }
    expect(quickstart).toContain('names the driver it detected on the host');
    expect(quickstart).toContain(
      'runs on the `local` profile stay on the in-process `local` driver, with no isolation, whatever driver that line names',
    );
    expect(developers).toContain(
      'runs on the <code>local</code> profile stay on the in-process <code>local</code> driver, with no isolation, whatever driver that line names',
    );
    expect(selfHosting).toContain(
      'agent runs on the `local` driver (no isolation) through the `local` runtime profile the runtime makes the workspace default, whatever driver its `Runtime:` startup line names',
    );

    // Issue #515: S1-19's journey job runs on main. The pages cite the run that gated it, say it
    // used packages packed from this repository and a stub model, and keep the npm caveat.
    expect(quickstart).not.toContain('exit test is the developer-journey CI job');
    expect(quickstart).not.toContain('exit test will be the developer-journey CI job');
    expect(developers).not.toContain('developer-journey CI job (S1-19) will run them');
    expect(developers).not.toContain('once the developer-journey CI job (S1-19) runs');
    expect(developers).toContain(
      'developer-journey CI job (Journey E2E, S1-19) runs this path end to end on every push to <code>main</code>',
    );
    // The job runs `aw check` only for its refusals, never step 4's passing check or `--yes`.
    expect(developers).toContain(
      "It does not run <code>--yes</code> or step 4's passing <code>aw check</code>; it runs <code>aw check</code> only to see it refuse an unsupported tool and a Viewer key.",
    );
    // The cited runs are named for where they ran: the main push run and the pull-request run.
    expect(developers).toContain(
      'Run 37041752925, the first push to <code>main</code> after the job merged, took 65.1 s of its 600 s budget; run 37039234031, on the pull request that merged it, took 62.7 s.',
    );
    expect(developers).not.toContain('(not `--yes` or `aw check`)');
    expect(developers).not.toContain('(not <code>--yes</code> or <code>aw check</code>)');
    expect(developers).not.toContain('run 37039234031 took 62.7 s of its 600 s budget');
    expect(developers).toContain(
      'It installs packages packed from this repository from a private local registry, and the model is a stub Anthropic API',
    );
    // The only sentence naming the public registry beside "proves" is the one denying it.
    const denial =
      /proves the path as (`main`|<code>main<\/code>) builds it, not from the public npm registry/u;
    expect(developers).toMatch(denial);
    expect(developers.replace(denial, '')).not.toMatch(
      /prov(?:es|en|ed)[^.]*public (?:npm )?registry/u,
    );
    expect(developers).toContain(
      'gets them with the next package release that includes <code>@indx-workspace/embedded</code>',
    );
    expect(developers).toContain(
      'Proven end to end on <code>main</code> by the developer-journey CI job (Journey E2E, S1-19), with packages packed from this repository and a stub Anthropic API; next, on npm with the release that includes <code>@indx-workspace/embedded</code>',
    );
    expect(developers).not.toMatch(
      /answering a message[^<]*<\/td><td>[^<]*<span[^>]*>Today<\/span><\/td><td>None/u,
    );
    // The aw check / aw push row keeps its npm caveat (the row's first cell contains markup, so
    // match the whole row up to its closing tag).
    const pushRow =
      /<tr><td><code>aw check<\/code>, <code>aw push<\/code> \/ <code>--yes<\/code>.*?<\/tr>/u.exec(
        developers,
      );
    expect(pushRow?.[0]).toContain(
      '<td>On npm with the next package release that includes <code>@indx-workspace/embedded</code></td></tr>',
    );

    // aw init prints `npm init -y` before the install line when package.json is missing.
    expect(quickstart).toContain('`npm init -y` when the directory has no `package.json`');

    // start names aw dev only when the kind: Project directory has no .env.
    expect(selfHosting).toContain('names it when the directory has no `.env`');

    // aw dev prints one ready screen; the runtime's own output goes to .aw/logs/runtime.log (#692).
    expect(quickstart).not.toContain('It prints, in order:');
    expect(quickstart).toContain('It prints one screen when everything is up');

    // Stale roadmap and front-door text.
    expect(developers).not.toContain('(0.1.0 is published)');
    expect(developers).toContain('superseded by the developer journey');
    expect(readme).not.toContain('Without a TTY, the generator uses the defaults');
    expect(readme).toContain(
      'npm create @indx-workspace@latest my-agent-platform -- --cloud local',
    );
  });

  // Issue #551 (S2-10): the tools guide, and Today only for what S2-08's journey job ran on main.
  it('describes what slice 2 made true, and nothing more', async () => {
    const read = async (relative: string) =>
      (await readFile(new URL(relative, repository), 'utf8')).replace(/\s+/gu, ' ');
    const docs = await read('docs/sdk/site/docs.json');
    const guide = await read('docs/sdk/site/guides/tools-from-code.mdx');
    const developers = await read('ui/developers.html');

    // The tools guide is a step of chapter 2 in the docs navigation.
    expect(docs).toContain('"guides/tools-from-code"');
    for (const fact of [
      'openapiTool(',
      "secret('ORDERS_TOKEN')",
      'approval_required',
      'tool_upstream_timeout',
      'advisory',
    ]) {
      expect(guide).toContain(fact);
    }
    // postgresTool is on main behind a closed gate (#598), so it gets one sentence, no section.
    expect(guide).toContain(
      "the gateway's gate for PostgreSQL tools is still closed (#598, parked)",
    );
    expect(guide).not.toContain('postgresTool({');
    // S2-05f was parked: no attachments.
    for (const page of [guide, developers]) expect(page).not.toMatch(/attachment/iu);

    // Every new Today figure cites the main run S2-08's job made.
    for (const page of [guide, developers]) {
      expect(page).toContain('37137992202');
    }
    expect(developers).toContain(
      'run 37137992202, on <code>main</code> at d0ceb28e, took 1.0 s of 60 s for B2, and 28.0 s and 4.0 s of 900 s for B3a and B3b.',
    );
    // The tools row is Today; postgresTool is named as gated, never badged on its own.
    expect(developers).toMatch(
      /<tr><td>Tools from code: <code>openapiTool\(\)<\/code>[^]*?<span class="badge badge--today">Today<\/span>[^]*?its gateway gate is closed \(#598\)<\/td><\/tr>/u,
    );
    expect(developers).not.toMatch(
      /postgresTool\(\)<\/code>[^<]*<\/td><td><span class="badge badge--today">/u,
    );
  });

  // Issue #787: docs truth sweep.
  it('states what runs, engines, agent writes and the sandbox-runtime driver do today', async () => {
    const read = async (relative: string) =>
      (await readFile(new URL(`docs/sdk/site/${relative}`, repository), 'utf8')).replace(
        /\s+/gu,
        ' ',
      );
    expect(await read('guides/evaluations.mdx')).toContain('node-version: 24');
    expect(await read('resources/observability.mdx')).toContain('`aw runs events <run-id>`');
    expect(await read('path/test.mdx')).toContain('with `aw runs events`');
    const runsPage = await read('resources/runs.mdx');
    expect(runsPage).not.toContain('on every run this release starts');
    expect(runsPage).toContain("`'claude-agent-sdk' | 'openai-agents' | 'pi' | 'mastra'`");
    const runtimes = await read('building/models-and-runtimes.mdx');
    expect(runtimes).not.toContain('gVisor-free');
    expect(runtimes).not.toContain('`sandbox-runtime.ts`');
    for (const page of [
      'path/build.mdx',
      'guides/agents-as-code.mdx',
      'features/agents-skills-tools-as-code.mdx',
      'features/run-observe-evaluate.mdx',
    ]) {
      const text = await read(page);
      expect(text, page).not.toMatch(/browser edits are not versioned/iu);
      expect(text, page).not.toMatch(/\baw agents update\b[^.]*\bsave(?:s)? no version/iu);
    }
  });

  // Issue #818: the id is accepted in contracts and old project files, but it has no implementation.
  it('never claims the sandbox-runtime driver is implemented or needs a sandbox tool', async () => {
    const site = new URL('docs/sdk/site/', repository);
    const pages = (await readdir(site, { recursive: true })).filter(
      (page) => page.endsWith('.mdx') && !page.startsWith('reference'),
    );
    const unimplemented = /not implemented|no implementation|reserved|without a driver/iu;
    let mentions = 0;
    for (const page of pages) {
      const text = (await readFile(new URL(page, site), 'utf8')).replace(/^```[^]*?^```/gmu, '');
      expect(text, page).not.toMatch(/bubblewrap|bwrap/iu);
      // A table row is one claim; prose is a paragraph.
      for (const block of text.split(/\n\s*\n|\n(?=\|)/u)) {
        if (!block.includes('sandbox-runtime')) continue;
        mentions += 1;
        const claim = block.replace(/\s+/gu, ' ');
        expect(claim, `${page}: ${claim}`).toMatch(unimplemented);
        expect(claim, `${page}: ${claim}`).not.toMatch(/\|\s*Implemented/u);
      }
    }
    expect(mentions).toBeGreaterThan(0);
  });

  // Issue #978: chapter 7 describes publish only where an executor exists on main.
  it('claims publish for every platform that has an executor', async () => {
    const read = async (relative: string) =>
      (await readFile(new URL(`docs/sdk/site/platforms/${relative}`, repository), 'utf8')).replace(
        /\s+/gu,
        ' ',
      );
    const foundry = await read('microsoft-foundry.mdx');
    expect(foundry).toContain('## Publish ```sh');
    expect(foundry).toContain('aw platforms publish --platform microsoft-foundry --yes');
    expect(foundry).toContain('az account get-access-token');
    expect(foundry).toContain('unverified against a live tenant');
    expect(foundry).not.toContain('not yet available');
    const gemini = await read('gemini-enterprise.mdx');
    expect(gemini).toContain('## Publish ```sh');
    expect(gemini).toContain('aw platforms publish --platform gemini-enterprise --yes');
    expect(gemini).toContain('gcloud auth print-access-token');
    expect(gemini).toContain('unverified against a live tenant');
    expect(gemini).not.toContain('not yet available');
    const managedAgents = await read('claude-managed-agents.mdx');
    expect(managedAgents).toContain('subagents_unsupported');
    expect(managedAgents).toContain('unverified against a live tenant');
    expect(managedAgents).not.toMatch(/live lane[^.]*\b(passed|verified|green)\b/iu);
    const executors = {
      'claude-managed-agents.mdx': 'ant apply',
      'copilot-studio.mdx': 'pac solution',
      'm365-declarative-agent.mdx': 'atk provision',
      'aws-agentcore.mdx': 'agentcore deploy',
    };
    for (const [page, command] of Object.entries(executors)) {
      expect(await read(page), page).toContain(command);
    }
    expect(await read('eject.mdx')).toContain('`aw platforms publish` refuses an eject target');
  });

  it('lists chapter 7 in the navigation after the last required chapter', async () => {
    const docs = JSON.parse(
      await readFile(new URL('docs/sdk/site/docs.json', repository), 'utf8'),
    ) as unknown;
    const groups = JSON.stringify(docs);
    expect(groups).toMatch(/"group":"7 · Run it on other platforms","pages":\["path\/platforms"/u);
    const operate = await readFile(new URL('docs/sdk/site/path/operate.mdx', repository), 'utf8');
    expect(operate).not.toContain('This is the last chapter');
  });

  const platformPages = async () => {
    const directory = new URL('docs/sdk/site/platforms/', repository);
    const pages = (await readdir(directory)).filter((page) => page.endsWith('.mdx'));
    return Promise.all(
      pages.map(async (page) => ({ page, text: await readFile(new URL(page, directory), 'utf8') })),
    );
  };

  it('names no retired target and no --target flag under platforms/', async () => {
    for (const { page, text } of await platformPages()) {
      // OpenAI Agent Builder shuts down on 2026-11-30.
      expect(text, page).not.toContain('Agent Builder');
      expect(text, page).not.toMatch(/--target\b/u);
    }
  });

  it('gives every platform guide the decided headings, in order', async () => {
    const headings = [
      'What you can do',
      'Before you start',
      'Export',
      'What maps and what is dropped',
      'Publish',
      'Your tools',
      'What is not there yet',
    ];
    const guides = [
      'claude-managed-agents.mdx',
      'copilot-studio.mdx',
      'm365-declarative-agent.mdx',
      'microsoft-foundry.mdx',
      'gemini-enterprise.mdx',
      'aws-agentcore.mdx',
    ];
    for (const guide of guides) {
      const text = await readFile(new URL(`docs/sdk/site/platforms/${guide}`, repository), 'utf8');
      const found = [...text.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
      expect(found, guide).toEqual(headings);
      expect(text, guide).toContain('](/platforms/matrix)');
    }
  });

  it('labels vendor commands still marked VERIFY and gates the live Copilot push', async () => {
    const read = async (relative: string) =>
      (await readFile(new URL(`docs/sdk/site/platforms/${relative}`, repository), 'utf8')).replace(
        /\s+/gu,
        ' ',
      );
    for (const page of ['claude-managed-agents.mdx', 'copilot-studio.mdx', 'aws-agentcore.mdx']) {
      expect(await read(page), page).toContain('unverified against a live tenant');
    }
    const copilot = await read('copilot-studio.mdx');
    const live = copilot
      .split(/(?<=\.) /u)
      .filter((sentence) => sentence.includes('pac solution import'));
    expect(live.length).toBeGreaterThan(0);
    for (const sentence of live) expect(sentence).toContain('--experimental');
  });
});
