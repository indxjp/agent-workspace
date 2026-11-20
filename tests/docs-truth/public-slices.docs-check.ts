/**
 * The slice-1 and slice-2 developer docs describe what main does, and nothing more.
 *
 * A static check of the `docs-check` lane (tests/static-checks/vitest.config.ts).
 */
import { describe, expect, it } from 'vitest';

import { readCollapsed, readSitePage } from './docs-truth.test-support.js';

interface Slice1Pages {
  quickstart: string;
  selfHosting: string;
  developers: string;
  readme: string;
}

async function readSlice1Pages(): Promise<Slice1Pages> {
  return {
    quickstart: await readSitePage('getting-started/quickstart.mdx'),
    selfHosting: await readSitePage('building/self-hosting.mdx'),
    developers: await readCollapsed('ui/developers.html'),
    readme: await readCollapsed('README.md'),
  };
}

// The generated project sets no runtime.default, so the Runtime: line names the host's driver,
// but runs on the `local` profile use the in-process `local` driver (no isolation) regardless,
// so no image is pulled on that path.
function expectLocalDriverClaims({ quickstart, selfHosting, developers }: Slice1Pages): void {
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
}

// Issue #515: S1-19's journey job runs on main. The pages cite the run that gated it, say it
// used packages packed from this repository and a stub model, and keep the npm caveat.
function expectJourneyJobClaims({ quickstart, developers }: Slice1Pages): void {
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
}

function expectNpmCaveats({ developers }: Slice1Pages): void {
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
}

function expectStartupAndRoadmapClaims({
  quickstart,
  selfHosting,
  developers,
  readme,
}: Slice1Pages): void {
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
  expect(readme).toContain('npm create @indx-workspace@latest my-agent-platform -- --cloud local');
}

// Issue #458 (S1-20): the slice-1 docs describe what main does, and nothing more.
describe('slice 1 docs describe what main does', () => {
  it('describes the aw dev path as main runs it and what the journey job proves', async () => {
    const pages = await readSlice1Pages();
    expectLocalDriverClaims(pages);
    expectJourneyJobClaims(pages);
    expectNpmCaveats(pages);
    expectStartupAndRoadmapClaims(pages);
  });
});

// Issue #551 (S2-10): the tools guide, and Today only for what S2-08's journey job ran on main.
describe('slice 2 docs describe what main does', () => {
  it('describes what slice 2 made true, and nothing more', async () => {
    const docs = await readSitePage('docs.json');
    const guide = await readSitePage('guides/tools-from-code.mdx');
    const developers = await readCollapsed('ui/developers.html');

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
});
