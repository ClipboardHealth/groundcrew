import { createStacksClient, type RunGhApi } from "./githubStacks.ts";

const REPOSITORY_CALL = { cwd: "/work/repo-a-team-2", repository: "acme/repo-a" };

function ghFake(response: string | Error): RunGhApi & { calls: Array<readonly string[]> } {
  const calls: Array<readonly string[]> = [];
  const fn = vi.fn<RunGhApi>(async ({ args }) => {
    calls.push(args);
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
  return Object.assign(fn, { calls });
}

const STACK_LISTING = JSON.stringify([
  {
    number: 1600,
    open: true,
    pull_requests: [{ number: 1591 }, { number: 1598 }],
  },
]);

describe(createStacksClient, () => {
  it("lists a repository's stacks", async () => {
    const runGh = ghFake(STACK_LISTING);

    const listing = await createStacksClient(runGh).listStacks(REPOSITORY_CALL);

    expect(listing).toEqual({
      available: true,
      stacks: [{ number: 1600, open: true, pullRequests: [1591, 1598] }],
    });
    expect(runGh.calls[0]).toEqual([
      "api",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      "repos/{owner}/{repo}/stacks",
    ]);
  });

  it("reports the API as unavailable when the listing call fails", async () => {
    const runGh = ghFake(new Error("HTTP 404"));

    const listing = await createStacksClient(runGh).listStacks(REPOSITORY_CALL);

    expect(listing).toEqual({ available: false, stacks: [] });
  });

  it.each([
    ["output that is not JSON", "not json"],
    ["output that is not an array", '{"number":1}'],
  ])("reads %s as no stacks", async (_name, response) => {
    const listing = await createStacksClient(ghFake(response)).listStacks(REPOSITORY_CALL);

    expect(listing.stacks).toEqual([]);
  });

  it("skips entries that do not describe a stack", async () => {
    const runGh = ghFake(
      JSON.stringify([
        null,
        { number: "1600", pull_requests: [] },
        { number: 1601, pull_requests: "nope" },
        { number: 1602, pull_requests: [{ number: 7 }, null, { number: "8" }] },
      ]),
    );

    const listing = await createStacksClient(runGh).listStacks(REPOSITORY_CALL);

    expect(listing.stacks).toEqual([{ number: 1602, open: true, pullRequests: [7] }]);
  });

  it("treats a stack without an explicit open flag as open, and a closed one as closed", async () => {
    const runGh = ghFake(
      JSON.stringify([
        { number: 1, pull_requests: [] },
        { number: 2, open: false, pull_requests: [] },
      ]),
    );

    const listing = await createStacksClient(runGh).listStacks(REPOSITORY_CALL);

    expect(listing.stacks.map((stack) => stack.open)).toEqual([true, false]);
  });

  it("creates a stack from an ordered list of pull requests", async () => {
    const runGh = ghFake("");

    const created = await createStacksClient(runGh).createStack({
      ...REPOSITORY_CALL,
      pullRequests: [3, 7],
      signal: AbortSignal.timeout(1000),
    });

    expect(created).toBe(true);
    expect(runGh.calls[0]).toEqual([
      "api",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      "repos/{owner}/{repo}/stacks",
      "--method",
      "POST",
      "-F",
      "pull_requests[]=3",
      "-F",
      "pull_requests[]=7",
    ]);
  });

  it("appends a pull request to an existing stack", async () => {
    const runGh = ghFake("");

    const client = createStacksClient(runGh);
    const added = await client.addToStack({
      ...REPOSITORY_CALL,
      stackNumber: 1600,
      pullRequests: [7],
      signal: AbortSignal.timeout(1000),
    });
    const addedWithoutSignal = await client.addToStack({
      ...REPOSITORY_CALL,
      stackNumber: 1600,
      pullRequests: [8],
    });

    expect([added, addedWithoutSignal]).toEqual([true, true]);
    expect(runGh.calls[0]).toContain("repos/{owner}/{repo}/stacks/1600/add");
  });

  it("reports a rejected write rather than throwing", async () => {
    const runGh = ghFake(new Error("HTTP 422: already part of a stack"));

    const created = await createStacksClient(runGh).createStack({
      ...REPOSITORY_CALL,
      pullRequests: [3, 7],
    });

    expect(created).toBe(false);
  });
});
