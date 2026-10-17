// Types for the approval token module, shared by the tracker server and the backend.
export interface SignedItem {
  readonly sourceMeeting: string;
  readonly title: string;
  readonly assignee: string;
  readonly due: string;
}
export function approvalToken(secret: string, item: SignedItem): string;
export function verifyApproval(secret: string, item: SignedItem, token: unknown): boolean;
