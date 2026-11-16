/**
 * The seed the deploy sends for each live catalog entry (`build.ts`, `run.ts`): every one builds
 * offline from the entry's own source, is a seed the platform would accept, carries the sample data
 * the catalog says it does and no secret, and is sent as the operator step's request.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DemoTemplateSeedSchema } from '@indx-workspace/contracts/demo-operator';
import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';
import { describe, expect, it } from 'vitest';

import { expectedTemplate } from '../daily/sample-check.ts';
import { buildSeed, liveEntries } from './build.ts';
import { readSettings, seedEntry } from './run.ts';

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
    expect(entries).toHaveLength(14);
    expect(new Set(entries.map((entry) => entry.slug)).size).toBe(entries.length);
    expect(entries.every((entry) => entry.status === 'live')).toBe(true);
  });

  it('carries records for five entries: crm-sales, quotation, service-desk, team-chat, wiki', () => {
    const withRecords = entries
      .filter((entry) => buildSeed(entry).records.length > 0)
      .map((entry) => entry.slug)
      .sort();
    expect(withRecords).toEqual(['crm-sales', 'quotation', 'service-desk', 'team-chat', 'wiki']);
  });

  it('carries records exactly for the entries whose catalog names a records folder', () => {
    for (const entry of entries) {
      const seed = buildSeed(entry);
      expect(seed.records.length > 0, entry.slug).toBe(entry.demo.records !== undefined);
      // Both languages, the same resources in each.
      const byLang = (lang: string) =>
        seed.records.filter((set) => set.lang === lang).map((set) => set.resource);
      expect(byLang('ja').sort(), entry.slug).toEqual(byLang('en').sort());
    }
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
    // Every gallery entry's agent uses a skill; the example apps' agents use none.
    expect(withSkills.length).toBeGreaterThan(0);
    expect(withSkills).toEqual(
      entries
        .filter((entry) => entry.source.startsWith('tests/gallery/'))
        .map((entry) => entry.slug),
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
      for (const connector of seed.connectors) {
        expect(Object.keys(connector).sort(), entry.slug).toEqual(['name', 'reads', 'writes']);
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

  it('needs the platform URL and the operator token, and names the missing one only', () => {
    expect(readSettings({})).toEqual({ missing: 'STORE_PLATFORM_URL' });
    expect(readSettings({ STORE_PLATFORM_URL: 'https://p.example.test' })).toEqual({
      missing: 'STORE_OPERATOR_TOKEN',
    });
    expect(
      readSettings({ STORE_PLATFORM_URL: 'https://p.example.test/', STORE_OPERATOR_TOKEN: 'x' }),
    ).toEqual({ baseUrl: 'https://p.example.test', token: 'x' });
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
