import type { LinearClient } from "@linear/sdk";

import { createLinearCommentsClient, FOLLOWUP_MARKER } from "./linearComments.ts";

interface ClientStub {
  comments: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
}

function makeClient(overrides: Partial<ClientStub> = {}): ClientStub {
  return {
    comments:
      overrides.comments ??
      vi.fn<() => Promise<{ nodes: { body: string }[] }>>().mockResolvedValue({ nodes: [] }),
    createComment:
      overrides.createComment ??
      vi.fn<() => Promise<{ success: true }>>().mockResolvedValue({
        success: true,
      }),
  };
}

function asLinearClient(stub: ClientStub): LinearClient {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests only touch the LinearClient surface used by createLinearCommentsClient
  return stub as unknown as LinearClient;
}

describe(createLinearCommentsClient, () => {
  describe("hasFollowup", () => {
    it("returns false when the issue has no comments", async () => {
      const stub = makeClient();
      const client = createLinearCommentsClient({
        client: asLinearClient(stub),
      });

      const actual = await client.hasFollowup("uuid-1");

      expect(actual).toBe(false);
      expect(stub.comments).toHaveBeenCalledWith({
        filter: { issue: { id: { eq: "uuid-1" } } },
      });
    });

    it("returns false when no comment contains the followup marker", async () => {
      const stub = makeClient({
        comments: vi.fn<() => Promise<{ nodes: { body: string }[] }>>().mockResolvedValue({
          nodes: [{ body: "some unrelated comment" }, { body: "another comment" }],
        }),
      });
      const client = createLinearCommentsClient({
        client: asLinearClient(stub),
      });

      await expect(client.hasFollowup("uuid-1")).resolves.toBe(false);
    });

    it("returns true when any comment contains the followup marker", async () => {
      const stub = makeClient({
        comments: vi.fn<() => Promise<{ nodes: { body: string }[] }>>().mockResolvedValue({
          nodes: [
            { body: "unrelated" },
            { body: `groundcrew finished team-1.\n\n${FOLLOWUP_MARKER}` },
          ],
        }),
      });
      const client = createLinearCommentsClient({
        client: asLinearClient(stub),
      });

      await expect(client.hasFollowup("uuid-1")).resolves.toBe(true);
    });
  });

  describe("postFollowup", () => {
    it("appends the marker when the body lacks it and posts the comment", async () => {
      const stub = makeClient();
      const client = createLinearCommentsClient({
        client: asLinearClient(stub),
      });

      await client.postFollowup({
        issueUuid: "uuid-1",
        body: "groundcrew finished team-1.",
      });

      expect(stub.createComment).toHaveBeenCalledWith({
        issueId: "uuid-1",
        body: `groundcrew finished team-1.\n\n${FOLLOWUP_MARKER}`,
      });
    });

    it("does not double-append when the body already contains the marker", async () => {
      const stub = makeClient();
      const client = createLinearCommentsClient({
        client: asLinearClient(stub),
      });

      const body = `groundcrew finished team-1.\n\n${FOLLOWUP_MARKER}`;
      await client.postFollowup({ issueUuid: "uuid-1", body });

      expect(stub.createComment).toHaveBeenCalledWith({
        issueId: "uuid-1",
        body,
      });
    });
  });
});
