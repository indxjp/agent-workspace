import { describe, expect, it } from 'vitest';

import { MalformedRunError } from './history';
import {
  MOCKUP_TEAM_CHILDREN,
  MOCKUP_TEAM_LEAD,
  MOCKUP_TEAM_LEAD_ID,
  MOCKUP_TEAM_RESEARCHER_ID,
  MOCKUP_TEAM_TREE_COST,
  MOCKUP_TEAM_WRITER_ID,
} from './mockup-fixture';
import {
  EMPTY_RUN_TREE,
  matchMemberCalls,
  memberNameOfTool,
  parseRunTree,
  runHref,
  teamRows,
  treeCostDisplay,
  type RunTree,
} from './run-tree-model';

const TREE: RunTree = { children: MOCKUP_TEAM_CHILDREN, treeCost: MOCKUP_TEAM_TREE_COST };

describe('memberNameOfTool', () => {
  it('reads the member from the neutral and the engine spelling', () => {
    expect(memberNameOfTool('agent__researcher')).toBe('researcher');
    expect(memberNameOfTool('mcp__agent__writer-2')).toBe('writer-2');
  });

  it('is null for every other tool and for a malformed member name', () => {
    expect(memberNameOfTool('Read')).toBeNull();
    expect(memberNameOfTool('mcp__connector-1__query')).toBeNull();
    expect(memberNameOfTool('agent__')).toBeNull();
    expect(memberNameOfTool('agent__Bad Name')).toBeNull();
    expect(memberNameOfTool(`agent__${'a'.repeat(53)}`)).toBeNull();
  });
});

describe('parseRunTree', () => {
  it('is the empty tree when the read carries neither field', () => {
    expect(parseRunTree({}, MOCKUP_TEAM_LEAD)).toBe(EMPTY_RUN_TREE);
  });

  it('parses the children and the tree cost', () => {
    const tree = parseRunTree(
      { children: MOCKUP_TEAM_CHILDREN, treeCost: MOCKUP_TEAM_TREE_COST },
      MOCKUP_TEAM_LEAD,
    );
    expect(tree.children.map((child) => child.id)).toEqual([
      MOCKUP_TEAM_RESEARCHER_ID,
      MOCKUP_TEAM_WRITER_ID,
    ]);
    expect(tree.treeCost).toEqual(MOCKUP_TEAM_TREE_COST);
  });

  it('refuses a child that names another parent, and children of a child', () => {
    const [first] = MOCKUP_TEAM_CHILDREN;
    expect(() =>
      parseRunTree(
        {
          children: [{ ...first, parentRunId: MOCKUP_TEAM_WRITER_ID }],
          treeCost: MOCKUP_TEAM_TREE_COST,
        },
        MOCKUP_TEAM_LEAD,
      ),
    ).toThrow(MalformedRunError);
    expect(() =>
      parseRunTree(
        { children: MOCKUP_TEAM_CHILDREN, treeCost: MOCKUP_TEAM_TREE_COST },
        { ...MOCKUP_TEAM_LEAD, parentRunId: MOCKUP_TEAM_LEAD_ID },
      ),
    ).toThrow(MalformedRunError);
  });

  it('refuses a malformed tree cost and a missing children list', () => {
    expect(() =>
      parseRunTree({ children: [], treeCost: { amount: '1', currency: 'USD' } }, MOCKUP_TEAM_LEAD),
    ).toThrow(MalformedRunError);
    expect(() =>
      parseRunTree(
        { children: [], treeCost: { ...MOCKUP_TEAM_TREE_COST, extra: true } },
        MOCKUP_TEAM_LEAD,
      ),
    ).toThrow(MalformedRunError);
    expect(() => parseRunTree({ treeCost: MOCKUP_TEAM_TREE_COST }, MOCKUP_TEAM_LEAD)).toThrow(
      MalformedRunError,
    );
  });
});

describe('teamRows', () => {
  it('orders the children oldest first and links each to its run', () => {
    const rows = teamRows({ ...TREE, children: [...MOCKUP_TEAM_CHILDREN].reverse() });
    expect(rows.map((row) => row.id)).toEqual([MOCKUP_TEAM_RESEARCHER_ID, MOCKUP_TEAM_WRITER_ID]);
    expect(rows[0]?.href).toBe(`/runs?run=${MOCKUP_TEAM_RESEARCHER_ID}`);
    expect(rows[0]?.cost).toBe('$0.02 · Actual');
    expect(rows[0]?.badge.label).toBe('Completed');
    expect(rows[1]?.cost).toBe('Pending');
    expect(rows[1]?.badge.dot).toBe(true);
  });

  it('runHref is the run detail panel link', () => {
    expect(runHref(MOCKUP_TEAM_LEAD_ID)).toBe(`/runs?run=${MOCKUP_TEAM_LEAD_ID}`);
  });
});

describe('treeCostDisplay', () => {
  it('formats the summed amount and says whether every run is priced', () => {
    expect(treeCostDisplay(MOCKUP_TEAM_LEAD, TREE)).toEqual({ amount: '$0.07', settled: false });
    const settled = MOCKUP_TEAM_CHILDREN.map((child) => ({
      ...child,
      accountingState: 'complete',
    }));
    expect(treeCostDisplay(MOCKUP_TEAM_LEAD, { ...TREE, children: settled })?.settled).toBe(true);
  });

  it('is null for a run without children', () => {
    expect(treeCostDisplay(MOCKUP_TEAM_LEAD, EMPTY_RUN_TREE)).toBeNull();
    expect(
      treeCostDisplay(MOCKUP_TEAM_LEAD, { children: [], treeCost: MOCKUP_TEAM_TREE_COST }),
    ).toBeNull();
  });
});

describe('matchMemberCalls', () => {
  const children = [
    { id: MOCKUP_TEAM_RESEARCHER_ID, agentName: 'researcher' },
    { id: MOCKUP_TEAM_WRITER_ID, agentName: 'writer' },
  ];

  it('links a call to the child of the same agent name, in either spelling', () => {
    const matched = matchMemberCalls(
      [
        { stepId: 's1', toolName: 'agent__writer' },
        { stepId: 's2', toolName: 'mcp__agent__researcher' },
      ],
      children,
    );
    expect(matched.get('s1')?.id).toBe(MOCKUP_TEAM_WRITER_ID);
    expect(matched.get('s2')?.id).toBe(MOCKUP_TEAM_RESEARCHER_ID);
  });

  it('falls back to call order, skips non-member tools and leaves a surplus call unlinked', () => {
    const matched = matchMemberCalls(
      [
        { stepId: 's0', toolName: 'Read' },
        { stepId: 's1', toolName: 'agent__alias' },
        { stepId: 's2', toolName: 'agent__alias' },
        { stepId: 's3', toolName: 'agent__alias' },
      ],
      children,
    );
    expect(matched.has('s0')).toBe(false);
    expect(matched.get('s1')?.id).toBe(MOCKUP_TEAM_RESEARCHER_ID);
    expect(matched.get('s2')?.id).toBe(MOCKUP_TEAM_WRITER_ID);
    expect(matched.has('s3')).toBe(false);
  });
});
