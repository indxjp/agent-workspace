/**
 * The seed the deploy sends for each live catalog entry (`build.ts`, `run.ts`): every one builds
 * offline from the entry's own source, is a seed the platform would accept, carries the sample data
 * the catalog says it does and no secret, and is sent as the operator step's request.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DemoSeedConnectorSchema,
  DemoTemplateSeedSchema,
  type DemoTemplateSeed,
} from '@indx-workspace/contracts/demo-operator';
import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';
import { PUBLIC_SOURCE_RECORDS_RESOURCE } from '@indx-workspace/sdk/define';
import { describe, expect, it } from 'vitest';

import { defineEntry, hasSource, type LiveEntry } from '../../../examples/store/catalog/define.ts';
import { CATALOG } from '../../../examples/store/catalog/index.ts';
import { expectedTemplate } from '../daily/sample-check.ts';
import {
  buildSeed,
  CONNECTOR_TOOLS,
  declaredConnector,
  liveEntries,
  PUBLIC_SOURCES,
  publicSourceSets,
  seededEntries,
} from './build.ts';
import { stagedView } from '../live-verify/source-hash.ts';
import { readSettings, seedEntry } from './run.ts';
import { fillVerification, readFillSettings } from './verification.ts';

const entries = liveEntries();
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('the seed of every live entry', () => {
  it.each(entries.map((entry) => [entry.slug, entry] as const))(
    '%s: builds offline and is a seed the platform accepts',
    (_slug, entry) => {
      const seed = buildSeed(entry);
      expect(DemoTemplateSeedSchema.safeParse(seed).success).toBe(true);
      // The platform's own rules (checkSeed) are applied to every live seed in
      // apps/web/server/demo/provision/seed.test.ts.
      expect(seed.definition.agent.name).toBe(entry.demo.agent);
    },
  );

  it('covers every live entry and no other', () => {
    // Production seeds the live entries; each must be an entry with its source and demo.
    expect(entries.map((entry) => entry.slug)).toEqual(
      seededEntries('production').map((entry) => entry.slug),
    );
    expect(entries.every(hasSource)).toBe(true);
    expect(new Set(entries.map((entry) => entry.slug)).size).toBe(entries.length);
    expect(entries.every((entry) => entry.status === 'live')).toBe(true);
  });

  it('carries records for the five entries with a records folder, the three whose gallery fixtures a read tool answers from and the two that read a public source', () => {
    const withRecords = entries
      .filter((entry) => buildSeed(entry).records.length > 0)
      .map((entry) => entry.slug)
      .sort();
    expect(withRecords).toEqual([
      'crm-sales',
      'market',
      'meeting-minutes',
      'quality-defect',
      'quotation',
      'ringi-review',
      'screening',
      'service-desk',
      'team-chat',
      'wiki',
    ]);
  });

  it("carries a records folder's sets and a public source's snapshot in both languages, and a gallery fixture's in Japanese", () => {
    for (const entry of entries) {
      const seed = buildSeed(entry);
      const snapshot = (set: { readonly resource: string }) =>
        set.resource === PUBLIC_SOURCE_RECORDS_RESOURCE;
      const byLang = (lang: string) =>
        seed.records
          .filter((set) => set.lang === lang && !snapshot(set))
          .map((set) => set.resource);
      if (entry.demo.records === undefined) expect(byLang('en'), entry.slug).toEqual([]);
      else expect(byLang('ja').sort(), entry.slug).toEqual(byLang('en').sort());
      expect(
        seed.records
          .filter(snapshot)
          .map((set) => set.lang)
          .sort(),
        entry.slug,
      ).toEqual(PUBLIC_SOURCES[entry.slug] === undefined ? [] : ['en', 'ja']);
    }
  });

  it("declares an openapiTool's admitted operations, and makes each of its writes wait for approval as its connector would", () => {
    const bySlug = new Map(entries.map((entry) => [entry.slug, buildSeed(entry)] as const));
    const qms = bySlug.get('quality-defect')?.connectors.find((c) => c.name === 'qms');
    expect(qms).toEqual({
      name: 'qms',
      reads: ['searchDefects', 'causeStats', 'getDefect'],
      writes: ['createCase'],
    });
    // The workflow document declares approveRequest and rejectRequest; allow does not admit them.
    const workflow = bySlug.get('ringi-review')?.connectors.find((c) => c.name === 'workflow');
    expect(workflow).toEqual({ name: 'workflow', reads: [], writes: ['postComment'] });
    const gates = (slug: string) => {
      const policy = bySlug.get(slug)?.definition.policy;
      return policy !== undefined && 'tools' in policy ? policy.requireApproval : undefined;
    };
    expect(gates('quotation')).toEqual(['mcp__erp__createQuote']);
    expect(gates('ringi-review')).toEqual(['mcp__workflow__postComment']);
    expect(gates('maintenance')).toEqual(['mcp__maintenance__logResolution']);
    // A gallery agent's own gate is kept beside them; an app's writes are not gated.
    expect(gates('cad-drafting')).toEqual(['Write']);
    expect(gates('crm-sales')).toBeUndefined();
  });

  it('carries exactly the files and record sets the nightly sample check expects', () => {
    for (const entry of entries) {
      const seed = buildSeed(entry);
      const want = expectedTemplate(entry);
      expect({ files: seed.files.length, recordSets: seed.records.length }, entry.slug).toEqual({
        files: want.files,
        recordSets: want.recordSets,
      });
    }
  });

  it("carries the sample files of the entry's demo.seed, at its collection paths, and nothing else", () => {
    for (const entry of entries) {
      const seed = buildSeed(entry);
      const collections = entry.demo.seed.map((folder) => folder.collection);
      for (const file of seed.files) {
        expect(
          collections.some((collection) => file.path.startsWith(`${collection}/`)),
          `${entry.slug}: ${file.path}`,
        ).toBe(true);
      }
      expect(seed.files.length > 0, entry.slug).toBe(entry.demo.seed.length > 0);
    }
  });

  it('makes the demo agent a copy: no model, no model connection, no runtime profile, no pinned skill revision', () => {
    for (const entry of entries) {
      const { definition } = buildSeed(entry);
      expect(definition.agent, entry.slug).toMatchObject({
        model: null,
        modelConnectionName: null,
        runtimeProfileName: null,
      });
      expect(definition.resources.skillRevisions, entry.slug).toBeUndefined();
    }
  });

  it("carries each skill the agent uses with its files from the entry's skills folder, built-ins by name only", () => {
    const withSkills: string[] = [];
    for (const entry of entries) {
      const seed = buildSeed(entry);
      const named = seed.definition.resources.skills;
      expect(
        seed.skills.map((skill) => skill.name),
        entry.slug,
      ).toEqual(named.filter((name) => !isBuiltinSkillName(name)));
      for (const skill of seed.skills) {
        const folder = path.join(REPOSITORY_ROOT, entry.source, 'skills', skill.name);
        expect(skill.files.map((file) => file.path).sort(), skill.name).toEqual(
          readdirSync(folder, { recursive: true, withFileTypes: true })
            .filter((dirent) => dirent.isFile())
            .map((dirent) =>
              path
                .relative(folder, path.join(dirent.parentPath, dirent.name))
                .split(path.sep)
                .join('/'),
            )
            .sort(),
        );
      }
      if (named.length > 0) withSkills.push(entry.slug);
    }
    // Every gallery and use-cases entry's agent uses a skill; the example apps' agents use none.
    expect(withSkills.length).toBeGreaterThan(0);
    expect(withSkills).toEqual(
      entries.filter((entry) => !entry.source.startsWith('examples/')).map((entry) => entry.slug),
    );
  });

  it('carries no secret: no credential, address or secret name', () => {
    const CREDENTIAL =
      /sk-ant|ERP_TOKEN|ERP_IDENTITY_SECRET|Bearer\s|postgres(?:ql)?:\/\/|https?:\/\/[^\s"]*@|AKIA[0-9A-Z]{12}|-----BEGIN/u;
    for (const entry of entries) {
      const seed = buildSeed(entry);
      // The sample and skill files are base64: look at their text too.
      const text = JSON.stringify({
        ...seed,
        files: seed.files.map((file) => Buffer.from(file.base64, 'base64').toString('utf8')),
        skills: seed.skills.map((skill) =>
          skill.files.map((file) => Buffer.from(file.base64, 'base64').toString('utf8')),
        ),
      });
      expect(text, entry.slug).not.toMatch(CREDENTIAL);
      // A connector names its tools and, for a records stand-in (ADR-0169), the writes it keeps by
      // tool name and record kind: no address, header or secret.
      for (const { recorded, ...connector } of seed.connectors) {
        expect(Object.keys(connector).sort(), entry.slug).toEqual(['name', 'reads', 'writes']);
        for (const kept of recorded ?? []) {
          expect(Object.keys(kept).sort(), entry.slug).toEqual(['kind', 'read', 'write']);
        }
      }
    }
  });

  it("maps the app entries' records to the app kit's read tools and the quotation's to its explicit lookups", () => {
    const bySlug = new Map(entries.map((entry) => [entry.slug, buildSeed(entry)] as const));
    const tools = (slug: string, resource: string) =>
      bySlug.get(slug)?.records.find((set) => set.resource === resource && set.lang === 'en')
        ?.tools;
    expect(tools('crm-sales', 'contact')).toEqual([
      'contact_list',
      'contact_get',
      'contact_search',
    ]);
    expect(tools('service-desk', 'kb_article')).toContain('kb_article_search');
    expect(tools('quotation', 'parts')).toEqual(['searchParts']);
    expect(tools('quotation', 'orders')).toEqual(['getOrder']);
    expect(tools('quotation', 'rates')).toEqual(['getRate']);
    const erp = bySlug.get('quotation')?.connectors.find((connector) => connector.name === 'erp');
    expect(erp).toEqual({
      name: 'erp',
      reads: ['searchParts', 'getOrder', 'getRate'],
      writes: ['createQuote'],
    });
    // A write tool of an app is declared as a write, never as a read.
    const crm = bySlug.get('crm-sales')?.connectors.find((connector) => connector.name === 'crm');
    expect(crm?.writes).toContain('contact_update');
    expect(crm?.reads).not.toContain('contact_update');
  });
});

describe('the seeding command', () => {
  const settings = { baseUrl: 'https://platform.example.test', token: 't'.repeat(40) };

  it('needs the platform URL, the operator token and the environment, and names the missing one only', () => {
    expect(readSettings({})).toEqual({ missing: 'STORE_PLATFORM_URL' });
    expect(readSettings({ STORE_PLATFORM_URL: 'https://p.example.test' })).toEqual({
      missing: 'STORE_OPERATOR_TOKEN',
    });
    const operator = { STORE_PLATFORM_URL: 'https://p.example.test/', STORE_OPERATOR_TOKEN: 'x' };
    expect(readSettings(operator)).toEqual({ missing: 'STORE_SEED_ENVIRONMENT' });
    expect(readSettings({ ...operator, STORE_SEED_ENVIRONMENT: 'preview' })).toEqual({
      missing: 'STORE_SEED_ENVIRONMENT',
    });
    expect(readSettings({ ...operator, STORE_SEED_ENVIRONMENT: ' staging ' })).toEqual({
      baseUrl: 'https://p.example.test',
      token: 'x',
      environment: 'staging',
    });
    expect(readSettings({ ...operator, STORE_SEED_ENVIRONMENT: 'production' })).toMatchObject({
      environment: 'production',
    });
  });

  it('PUTs the seed to the entry with the operator token, and prints the entry and whether it changed', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('no live entry');
    const seed = buildSeed(entry);
    const calls: { url: string; method: string; authorization: string | null; body: unknown }[] =
      [];
    const send = ((url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? '',
        authorization: new Headers(init.headers).get('authorization'),
        body: JSON.parse(init.body as string) as unknown,
      });
      return Promise.resolve(Response.json({ entry: entry.slug, changed: calls.length === 1 }));
    }) as unknown as typeof fetch;
    const first = await seedEntry(settings, entry.slug, seed, send);
    const second = await seedEntry(settings, entry.slug, seed, send);
    expect(first).toEqual({ line: `${entry.slug}: changed`, ok: true });
    expect(second).toEqual({ line: `${entry.slug}: unchanged`, ok: true });
    expect(calls[0]).toMatchObject({
      url: `https://platform.example.test/api/demo/templates/${entry.slug}`,
      method: 'PUT',
      authorization: `Bearer ${settings.token}`,
    });
    expect(calls[0]?.body).toEqual(JSON.parse(JSON.stringify(seed)));
  });

  it('prints a refusal as its status and problem code, never the token or the body', async () => {
    const send = (() =>
      Promise.resolve(
        Response.json(
          { error: { code: 'demo_seed_invalid', message: 'contains sk-secret-value' } },
          { status: 400 },
        ),
      )) as unknown as typeof fetch;
    const result = await seedEntry(settings, 'wiki', {}, send);
    expect(result).toEqual({ line: 'wiki: refused 400 demo_seed_invalid', ok: false });
    expect(result.line).not.toContain(settings.token);
  });

  it('prints only the status when the answer has no problem body', async () => {
    const send = (() =>
      Promise.resolve(new Response('nope', { status: 502 }))) as unknown as typeof fetch;
    expect(await seedEntry(settings, 'wiki', {}, send)).toEqual({
      line: 'wiki: refused 502 unknown',
      ok: false,
    });
  });
});

/** `entry` without its staged rebuild (`next`, ADR-0174), as a fixture for another shape. */
function withoutRebuild(entry: LiveEntry): LiveEntry {
  const { next, ...current } = entry;
  return next === undefined ? entry : current;
}

describe('the seed of a coming-soon entry with its code merged', () => {
  // A batch PR merges an entry's code while it is still coming soon; the staging deploy seeds it so
  // R1 can verify it before the flip. Any entry with a source stands in for one here.
  const listed = entries.find((entry) => entry.slug === 'ringi-review');
  if (listed === undefined) throw new Error('the catalog has no ringi-review entry');
  const base = withoutRebuild(listed);
  const soon = defineEntry({ ...base, status: 'soon', wave: 2 });
  const bare = defineEntry({
    slug: 'proposal',
    area: 'sales',
    status: 'soon',
    wave: 2,
    name: { ja: '提案書ドラフト', en: 'Proposal drafter' },
    summary: { ja: '骨子を作る。', en: 'Drafts an outline.' },
  });

  it('is seeded in staging, beside every live entry, and never in production', () => {
    const staging = seededEntries('staging', [base, soon, bare]).map((entry) => entry.status);
    expect(staging).toEqual(['live', 'soon']);
    expect(seededEntries('production', [base, soon, bare])).toEqual([base]);
    // The catalog as it is: production seeds exactly the live entries, staging every one with a
    // source.
    expect(seededEntries('production')).toEqual(entries);
    expect(seededEntries('staging').map((entry) => entry.slug)).toEqual(
      CATALOG.filter(hasSource).map((entry) => entry.slug),
    );
  });

  it('builds the same seed it will have once live', () => {
    if (!hasSource(soon)) throw new Error('the soon entry has no source');
    const seed = buildSeed(soon);
    expect(DemoTemplateSeedSchema.safeParse(seed).success).toBe(true);
    expect(seed).toEqual(buildSeed(base));
    expect(seed.definition.agent.name).toBe(soon.demo.agent);
  });
});

describe('the seed of a live entry with a staged rebuild (next, ADR-0174)', () => {
  // A rebuild is merged beside the live entry's current source: staging seeds and R1 verifies the
  // rebuild, production keeps the source visitors try. Another entry's use case stands in for it.
  const listed = entries.find((entry) => entry.slug === 'ringi-review');
  const nda = CATALOG.find((entry) => entry.slug === 'nda');
  if (listed === undefined || nda === undefined || !hasSource(nda)) {
    throw new Error('the catalog has no ringi-review or nda entry with a source');
  }
  const base = withoutRebuild(listed);
  const rebuilt = defineEntry({ ...base, next: { source: nda.source, demo: nda.demo } });
  if (rebuilt.status !== 'live') throw new Error('the rebuilt entry is live');

  it('is seeded as its rebuild in staging and as its current source in production', () => {
    const [staging] = seededEntries('staging', [rebuilt]);
    expect(staging).toEqual({ ...base, source: nda.source, demo: nda.demo });
    expect(staging).toEqual(stagedView(rebuilt));
    expect(seededEntries('production', [rebuilt])).toEqual([rebuilt]);
    if (staging === undefined) throw new Error('staging seeds the rebuilt entry');
    expect(buildSeed(staging).definition.agent.name).toBe(nda.demo.agent);
    expect(buildSeed(staging).files).toEqual(buildSeed(nda).files);
    // The gallery's authority fixture belongs to the gallery source, not to the rebuild.
    expect(buildSeed(staging).records).toEqual(buildSeed(nda).records);
    expect(buildSeed(rebuilt).records.map((set) => set.connector)).toEqual(['authority']);
    expect(buildSeed(rebuilt)).toEqual(buildSeed(base));
  });

  it('leaves an entry with no rebuild as it is', () => {
    expect(stagedView(base)).toBe(base);
    expect(stagedView(nda)).toBe(nda);
  });
});

/**
 * What one workspace cannot hold for two entries at once (the verification workspace holds every
 * seeded entry, runbook §10): two agents with one name (the harness finds an entry's copy by its
 * agent's name), or one sample file path or one carried skill name with two contents (a folder and a
 * skill are found by path and name, so the second copy would replace the first's). A connector name
 * is not among them: each entry's stand-in is its own (`template-copy-connectors.ts`).
 */
function sharedContentConflicts(
  seeds: readonly { readonly slug: string; readonly seed: DemoTemplateSeed }[],
): readonly string[] {
  const held = new Map<string, { readonly slug: string; readonly content: string }>();
  const conflicts: string[] = [];
  const hold = (key: string, slug: string, content: string) => {
    const first = held.get(key);
    if (first === undefined) held.set(key, { slug, content });
    else if (first.content !== content) conflicts.push(`${key}: ${first.slug} and ${slug}`);
  };
  for (const { slug, seed } of seeds) {
    hold(`agent ${seed.definition.agent.name}`, slug, slug);
    for (const file of seed.files) hold(`file ${file.path}`, slug, file.base64);
    for (const skill of seed.skills) hold(`skill ${skill.name}`, slug, JSON.stringify(skill.files));
  }
  return conflicts;
}

describe('what the verification workspace holds for every seeded entry at once', () => {
  it('no two seeded entries share an agent name, or a sample file path or skill name with other content', () => {
    const seeds = seededEntries('staging').map((entry) => ({
      slug: entry.slug,
      seed: buildSeed(entry),
    }));
    expect(sharedContentConflicts(seeds)).toEqual([]);
  });

  it('names each kind of conflict, and lets two entries share the same file or skill', () => {
    const base = entries.find((entry) => entry.slug === 'contract-review');
    if (base === undefined) throw new Error('the catalog has no contract-review entry');
    const seed = buildSeed(base);
    const [file] = seed.files;
    const [skill] = seed.skills;
    if (file === undefined || skill === undefined) throw new Error('contract-review has no file');
    const other: DemoTemplateSeed = {
      ...seed,
      files: [{ ...file, base64: Buffer.from('other').toString('base64') }],
      skills: [{ ...skill, files: [] }],
    };
    expect(
      sharedContentConflicts([
        { slug: 'a', seed },
        { slug: 'b', seed: other },
      ]),
    ).toEqual([
      `agent ${seed.definition.agent.name}: a and b`,
      `file ${file.path}: a and b`,
      `skill ${skill.name}: a and b`,
    ]);
    const renamed = {
      ...seed,
      definition: { ...seed.definition, agent: { ...seed.definition.agent, name: 'other' } },
    };
    expect(
      sharedContentConflicts([
        { slug: 'a', seed },
        { slug: 'b', seed: renamed },
      ]),
    ).toEqual([]);
  });
});

describe('the connectors a seed declares', () => {
  it("declares the incident router's tracker with the task write a records stand-in keeps", () => {
    const tracker = CONNECTOR_TOOLS['incident']?.['tracker'];
    expect(tracker).toBeDefined();
    const declared = declaredConnector('tracker', tracker ?? { reads: [], writes: [] });
    expect(DemoSeedConnectorSchema.parse(declared)).toEqual({
      name: 'tracker',
      reads: ['list_tasks'],
      writes: ['create_task'],
      recorded: [{ write: 'create_task', kind: 'task', read: 'list_tasks' }],
    });
  });

  it('names recorded only for a connector that keeps a write, and every recorded write is its own', () => {
    expect(declaredConnector('authority', { reads: ['check_authority'], writes: [] })).toEqual({
      name: 'authority',
      reads: ['check_authority'],
      writes: [],
    });
    for (const [slug, connectors] of Object.entries(CONNECTOR_TOOLS)) {
      for (const [name, tools] of Object.entries(connectors)) {
        expect(
          DemoSeedConnectorSchema.safeParse(declaredConnector(name, tools)).success,
          `${slug}: ${name}`,
        ).toBe(true);
      }
    }
  });
});

describe('the public-source tools a seed declares (ADR-0170 D4)', () => {
  it("declares each entry's public-source tool as a read and files the project's own snapshot for it", () => {
    for (const [slug, { tool, source }] of Object.entries(PUBLIC_SOURCES)) {
      const entry = CATALOG.find((candidate) => candidate.slug === slug);
      if (entry === undefined || !hasSource(entry)) throw new Error(`${slug}: no sourced entry`);
      const seed = buildSeed(entry);
      expect(seed.connectors).toContainEqual({
        name: 'aw-dev-tools',
        reads: [tool.name],
        writes: [],
      });
      const sets = seed.records.filter((set) => set.resource === 'public-source-snapshot');
      expect(sets.map((set) => [set.connector, set.lang, set.tools])).toEqual([
        ['aw-dev-tools', 'ja', [tool.name]],
        ['aw-dev-tools', 'en', [tool.name]],
      ]);
      for (const set of sets) expect(set.data).toEqual(source.snapshot);
    }
  });

  it('files no public-source set for an entry without one', () => {
    expect(publicSourceSets('policy-qa')).toEqual([]);
  });
});

describe('the verification refresh', () => {
  const WORKSPACE = '0b8f4f2e-6a51-4c43-9d55-2f0b0f6d7c11';
  const operator = { STORE_PLATFORM_URL: 'https://p.example.test/', STORE_OPERATOR_TOKEN: 'x' };
  const settings = {
    baseUrl: 'https://p.example.test',
    token: 't'.repeat(40),
    workspaceId: WORKSPACE,
  };
  const answering =
    (response: Response): typeof fetch =>
    () =>
      Promise.resolve(response);

  it('needs the platform URL, the operator token and a workspace id, and names the missing one only', () => {
    expect(readFillSettings({})).toEqual({ missing: 'STORE_PLATFORM_URL' });
    expect(readFillSettings(operator)).toEqual({ missing: 'STORE_VERIFICATION_WORKSPACE_ID' });
    expect(
      readFillSettings({ ...operator, STORE_VERIFICATION_WORKSPACE_ID: '../templates' }),
    ).toEqual({ missing: 'STORE_VERIFICATION_WORKSPACE_ID' });
    expect(
      readFillSettings({ ...operator, STORE_VERIFICATION_WORKSPACE_ID: ` ${WORKSPACE} ` }),
    ).toEqual({ baseUrl: 'https://p.example.test', token: 'x', workspaceId: WORKSPACE });
  });

  it('PUTs the fill with the operator token and no body, and prints the entries copied', async () => {
    const calls: { url: string; method: string; authorization: string | null; body: unknown }[] =
      [];
    const send = ((url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? '',
        authorization: new Headers(init.headers).get('authorization'),
        body: init.body,
      });
      return Promise.resolve(Response.json({ workspaceId: WORKSPACE, entries: ['wiki', 'nda'] }));
    }) as unknown as typeof fetch;
    expect(await fillVerification(settings, ['nda', 'wiki'], send)).toEqual({
      line: 'verification workspace: copied wiki, nda',
      ok: true,
    });
    expect(calls).toEqual([
      {
        url: `https://p.example.test/api/demo/verification/${WORKSPACE}`,
        method: 'PUT',
        authorization: `Bearer ${settings.token}`,
        body: undefined,
      },
    ]);
  });

  it('fails when a seeded entry was not copied, the answer is unreadable or the platform refuses', async () => {
    const partial = Response.json({ workspaceId: WORKSPACE, entries: ['wiki'] });
    expect(await fillVerification(settings, ['wiki', 'nda'], answering(partial))).toEqual({
      line: 'verification workspace: copied wiki; not copied nda',
      ok: false,
    });
    const unreadable = Response.json({ entries: 'all' });
    expect(await fillVerification(settings, [], answering(unreadable))).toEqual({
      line: 'verification workspace: the answer is not readable',
      ok: false,
    });
    const refused = Response.json(
      { error: { code: 'verification_workspace_refused', message: settings.token } },
      { status: 409 },
    );
    const result = await fillVerification(settings, [], answering(refused));
    expect(result).toEqual({
      line: 'verification workspace: refused 409 verification_workspace_refused',
      ok: false,
    });
    expect(result.line).not.toContain(settings.token);
  });
});
