/** The label an audit row carries for a person (their email), by principal id. Throws for a non-member. */
export type ActorLabel = (workspaceId: string, principalId: string) => Promise<string>;
