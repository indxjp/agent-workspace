import { BUILDER_MODEL } from '@indx-workspace/contracts/builder';

/** The model-connections page of the developer docs. */
const MODEL_CONNECTIONS_DOCS = 'https://docs.agentworkspace.indx.jp/resources/models';

/** The sentence a refused Builder run answers: the model it needs, and where to add a connection. */
export function builderModelUnavailableMessage(): string {
  return (
    `The Builder runs on model ${BUILDER_MODEL}, and no model connection in this workspace ` +
    `serves it. Add or fix a connection that offers it: ${MODEL_CONNECTIONS_DOCS}`
  );
}
