import { createInMemoryAgentStoreProvider } from '../../agents/memory-store';
import { describe, expect, it } from 'vitest';

import { counterIds } from '../../ids';
import { createMemoryDirectory } from '../../rbac/memory-directory';
import {
  createTemplateWorkspaces,
  wireDemoTemplateOperations,
  wireDemoVerification,
} from './demo-templates';

const NOW = new Date('2026-11-16T09:00:00.000Z');

/** A workspaces repository that records what it was asked to create, with the slugs it already has. */
function repository(taken: readonly string[] = []) {
  const created: { name: string; slug: string; ownerUserId: string }[] = [];
  const slugs = new Map<string, string>(taken.map((slug, n) => [`id-${String(n)}`, slug]));
  return {
    created,
    workspaces: {
      create: (input: { name: string; slug: string; ownerUserId: string }) => {
        if (taken.includes(input.slug))
          return Promise.resolve({ kind: 'conflict' as const, slug: input.slug });
        created.push(input);
        slugs.set(`made-${String(created.length)}`, input.slug);
        return Promise.resolve({
          kind: 'created' as const,
          workspace: { id: `made-${String(created.length)}` },
        });
      },
      get: (id: string) => {
        const slug = slugs.get(id);
        return Promise.resolve(slug === undefined ? null : { slug });
      },
    },
    ids: () => Promise.resolve([...slugs.keys()]),
  };
}

describe('createTemplateWorkspaces', () => {
  it("makes the owner's user through the directory, then the workspace with that user as its Owner", async () => {
    const repo = repository();
    const directory = createMemoryDirectory();
    const maker = createTemplateWorkspaces({
      directory,
      workspaces: repo.workspaces,
      listWorkspaceIds: repo.ids,
      ids: counterIds(),
    });
    const id = await maker.make({
      slug: 'demo-template-crm-sales',
      name: 'Agent Store demo template: crm-sales',
      ownerEmail: 'crm-sales@demo-templates.invalid',
      now: NOW,
    });
    expect(id).toBe('made-1');
    const [made] = repo.created;
    expect(made).toMatchObject({ slug: 'demo-template-crm-sales' });
    // The user it names is the one the directory made for that address.
    const memberships = await directory.membershipsForUser(made?.ownerUserId ?? '');
    expect(memberships.length).toBeGreaterThan(0);
  });

  it('answers null for a slug that is already taken, so the caller finds the workspace', async () => {
    const repo = repository(['demo-template-wiki']);
    const maker = createTemplateWorkspaces({
      directory: createMemoryDirectory(),
      workspaces: repo.workspaces,
      listWorkspaceIds: repo.ids,
      ids: counterIds(),
    });
    expect(
      await maker.make({
        slug: 'demo-template-wiki',
        name: 'x',
        ownerEmail: 'wiki@demo-templates.invalid',
        now: NOW,
      }),
    ).toBeNull();
  });

  it('lists only the slugs in the reserved template namespace', async () => {
    const repo = repository([
      'demo-template-wiki',
      'demo-0123456789ab',
      'acme',
      'demo-template-quotation',
    ]);
    const maker = createTemplateWorkspaces({
      directory: createMemoryDirectory(),
      workspaces: repo.workspaces,
      listWorkspaceIds: repo.ids,
      ids: counterIds(),
    });
    expect([...(await maker.templateSlugs())].sort()).toEqual([
      'demo-template-quotation',
      'demo-template-wiki',
    ]);
  });
});

describe('wireDemoTemplateOperations', () => {
  const unused = { workspaces: {}, listWorkspaceIds: () => Promise.resolve([]) } as never;
  const scopes = { forWorkspaceSlug: () => Promise.resolve(null) };

  it('has no operations where the deployment cannot hold a template', () => {
    for (const domains of [
      { agents: createInMemoryAgentStoreProvider(), connectors: null, files: {} },
      {
        agents: createInMemoryAgentStoreProvider(),
        connectors: null,
        files: {},
        agentGrants: undefined,
      },
    ]) {
      expect(
        wireDemoTemplateOperations({
          scopes,
          directory: createMemoryDirectory(),
          domains,
          settings: {
            demoAnthropicApiKey: null,
            demo: { maxTurnsPerRun: null, maxCostPerRunUsd: null },
          },
          workspaces: unused,
        }),
      ).toBeNull();
    }
  });

  it('has no verification fill without template operations', () => {
    const input = {
      scopes,
      directory: createMemoryDirectory(),
      domains: { agents: createInMemoryAgentStoreProvider(), connectors: null, files: {} },
      settings: {
        demoAnthropicApiKey: null,
        demo: { maxTurnsPerRun: null, maxCostPerRunUsd: null },
      },
      workspaces: unused,
    };
    expect(wireDemoVerification(input, wireDemoTemplateOperations(input))).toBeNull();
  });
});
