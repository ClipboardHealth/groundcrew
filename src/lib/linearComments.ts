import type { LinearClient } from "@linear/sdk";

export const FOLLOWUP_MARKER = "<!-- groundcrew:followup -->";

export interface LinearCommentsClient {
  hasFollowup(issueUuid: string): Promise<boolean>;
  postFollowup(arguments_: { issueUuid: string; body: string }): Promise<void>;
}

export function createLinearCommentsClient(deps: { client: LinearClient }): LinearCommentsClient {
  const { client } = deps;
  return {
    async hasFollowup(issueUuid) {
      const result = await client.comments({
        filter: { issue: { id: { eq: issueUuid } } },
      });
      return result.nodes.some((node) => node.body.includes(FOLLOWUP_MARKER));
    },
    async postFollowup(arguments_) {
      const { issueUuid, body } = arguments_;
      const stamped = body.includes(FOLLOWUP_MARKER) ? body : `${body}\n\n${FOLLOWUP_MARKER}`;
      await client.createComment({ issueId: issueUuid, body: stamped });
    },
  };
}
