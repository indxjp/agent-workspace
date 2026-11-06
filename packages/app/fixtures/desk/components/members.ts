import type { ChannelMember } from '@indx-workspace/app/react';

/** The desk's one person's principal id, which `server/desk.ts` answers `GET /api/me` with. */
export const DESK_PERSON_ID = '33333333-3333-4333-8333-333333333333';

/** Who a desk channel message can mention: its one person and its triage agent. */
export const DESK_MEMBERS: readonly ChannelMember[] = [
  { principalId: DESK_PERSON_ID, name: 'Desk person' },
  { principalId: '11111111-1111-4111-8111-111111111111', name: 'Triage' },
];

/** The room the desk seeds, which the channel page opens. */
export const DESK_ROOM_TITLE = 'general';
