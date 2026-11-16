import { registerCompareAndSetCases } from './agent-versions.compare-and-set.test-support.js';
import { registerConnectorResolutionCases } from './agent-versions.connector-resolution.test-support.js';
import { registerConstraintsCases } from './agent-versions.constraints.test-support.js';
import { registerCreationAuditCases } from './agent-versions.creation-audit.test-support.js';
import { registerCreationCases } from './agent-versions.creation.test-support.js';
import { registerEnvironmentsCases } from './agent-versions.environments.test-support.js';
import { registerMaterialisationCases } from './agent-versions.materialisation.test-support.js';
import { registerOwnershipRuntimeCases } from './agent-versions.ownership-runtime.test-support.js';
import { registerReferencesCases } from './agent-versions.references.test-support.js';
import { registerSessionVersionCases } from './agent-versions.session-version.test-support.js';
import { registerSubagentsCases } from './agent-versions.subagents.test-support.js';
import { READ_ONLY, createAgentVersionFixture } from './agent-versions.fixture.test-support.js';
/**
 * The agent version store (#442, S1-04, ADR-0101) against real PostgreSQL, plus the pure matcher
 * and the #133 `writeFiles` ceiling it shares.
 *
 * What only a real database can prove is here: the tenant-paired foreign keys of
 * `agent_version_pointers`, version numbering under concurrent writers, the all-or-nothing
 * `applyAndPoint` and `createAgentWithFirstVersion` transactions, C7's default-connection rule and
 * C9's one-surface-name-per-environment rule, and the workspace default runtime profile a version
 * that names none resolves to (#504, S1-22).
 */

import { describe, expect, it } from 'vitest';

import {
  classifyReferenceMatches,
  narrowFileGrants,
  narrowStorageGrants,
  resolveFromRows,
  storageGrantChange,
} from './agent-versions-resolution.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[repositories/agent-versions.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the agent ' +
      'version store was NOT exercised against a real PostgreSQL.',
  );
}

/** A version body with these surface names; core stores it unparsed. */

describe('classifyReferenceMatches', () => {
  it('reports a name two rows share as ambiguous and resolves neither', () => {
    // The per-workspace unique name keys (`mcp_servers_workspace_name_key` and its siblings) make
    // two matches unreachable in PostgreSQL today, so this arm is proven here, without a database.
    const matches = classifyReferenceMatches(
      'connector',
      ['github', 'linear'],
      [
        { id: 'c1', name: 'github' },
        { id: 'c2', name: 'github' },
        { id: 'c3', name: 'linear' },
      ],
    );
    expect(matches.ambiguous).toEqual([{ kind: 'connector', name: 'github' }]);
    expect(matches.missing).toEqual([]);
    expect([...matches.ids]).toEqual([['linear', 'c3']]);
  });

  it('matches exactly, and reports a missing name once', () => {
    const matches = classifyReferenceMatches(
      'skill',
      ['Reviewer', 'nope', 'nope'],
      [{ id: 's1', name: 'reviewer' }],
    );
    expect(matches.missing).toEqual([
      { kind: 'skill', name: 'Reviewer' },
      { kind: 'skill', name: 'nope' },
    ]);
    expect(matches.ids.size).toBe(0);
  });
});

describe('resolveFromRows', () => {
  const references = {
    modelConnectionName: null,
    runtimeProfileName: null,
    skills: [],
    connectors: [],
    files: [],
  };

  it('resolves C7 default to the deployment default when no connection is named default', () => {
    expect(resolveFromRows(references, {}, 'p1')).toEqual({
      kind: 'resolved',
      references: {
        modelConnectionId: null,
        runtimeProfileId: 'p1',
        skillIds: [],
        connectorIds: [],
        files: [],
      },
    });
  });

  it('reports a default two connections share as ambiguous, never as the deployment default', () => {
    const rows = {
      'model-connection': [
        { id: 'm1', name: 'default' },
        { id: 'm2', name: 'default' },
      ],
    };
    expect(resolveFromRows(references, rows, null)).toEqual({
      kind: 'unresolved',
      missing: [],
      ambiguous: [{ kind: 'model-connection', name: 'default' }],
    });
  });
});

describe('narrowStorageGrants and storageGrantChange', () => {
  const folder = (connectionId: string, prefix: string, access: 'read' | 'read-write') => ({
    connectionId,
    prefix,
    access,
  });

  // @story US-STO-12
  it('[US-STO-12][contract][sdk] narrows read-write to read without writeFiles, and keeps the wider duplicate', () => {
    const grants = [
      folder('c1', 'reports', 'read'),
      folder('c1', 'reports', 'read-write'),
      folder('c2', 'archive', 'read'),
    ];
    expect(narrowStorageGrants(grants, READ_ONLY)).toEqual([
      folder('c1', 'reports', 'read'),
      folder('c2', 'archive', 'read'),
    ]);
    expect(narrowStorageGrants(grants, { ...READ_ONLY, writeFiles: true })).toEqual([
      folder('c1', 'reports', 'read-write'),
      folder('c2', 'archive', 'read'),
    ]);
  });

  // @story US-STO-12
  it('[US-STO-12][contract][sdk] describes a change by id, access and prefix, and none for equal sets', () => {
    const one = folder('c1', 'reports', 'read');
    const two = folder('c2', 'archive', 'read-write');
    expect(storageGrantChange([one, two], [two, one])).toBeNull();
    expect(storageGrantChange([], [])).toBeNull();
    expect(storageGrantChange([one], [one, two])).toBe('c1 read reports; c2 read-write archive');
    expect(storageGrantChange([one], [])).toBe('no storage grants');
    expect(storageGrantChange([one], [folder('c1', 'reports', 'read-write')])).toBe(
      'c1 read-write reports',
    );
  });
});

describe('narrowFileGrants', () => {
  const grants = [
    { fileId: 'f1', access: 'read-write' as const },
    { fileId: 'f2', access: 'read' as const },
  ];

  it('narrows read-write to read when writeFiles is off (#133)', () => {
    expect(narrowFileGrants(grants, READ_ONLY)).toEqual([
      { fileId: 'f1', access: 'read' },
      { fileId: 'f2', access: 'read' },
    ]);
  });

  it('keeps read-write when writeFiles is on, and one grant per file', () => {
    expect(
      narrowFileGrants([...grants, { fileId: 'f1', access: 'read' }], {
        ...READ_ONLY,
        writeFiles: true,
      }),
    ).toEqual(grants);
  });
});

describe.skipIf(!hasDatabase)('AgentVersionRepository against real PostgreSQL', () => {
  const fixture = createAgentVersionFixture();
  registerConstraintsCases(fixture);
  registerMaterialisationCases(fixture);
  registerCompareAndSetCases(fixture);
  registerReferencesCases(fixture);
  registerConnectorResolutionCases(fixture);
  registerSubagentsCases(fixture);
  registerEnvironmentsCases(fixture);
  registerSessionVersionCases(fixture);
  registerCreationCases(fixture);
  registerCreationAuditCases(fixture);
  registerOwnershipRuntimeCases(fixture);
});
