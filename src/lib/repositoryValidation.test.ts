import { canonicalLinearIssue } from "./testing/canonicalFixtures.ts";
import { dispatchableRepository } from "./repositoryValidation.ts";

describe(dispatchableRepository, () => {
  it("returns the repository when it is in knownRepositories", () => {
    const issue = canonicalLinearIssue({
      naturalId: "team-1",
      repository: "repo-a",
      agent: "claude",
    });
    const log = vi.fn<(message: string) => void>();

    const result = dispatchableRepository(issue, ["repo-a", "repo-b"], log);

    expect(result).toBe("repo-a");
    expect(log).not.toHaveBeenCalled();
  });

  it("returns undefined and logs a warning when the repository is not in knownRepositories", () => {
    const issue = canonicalLinearIssue({
      naturalId: "team-2",
      repository: "unknown-repo",
      agent: "claude",
    });
    const log = vi.fn<(message: string) => void>();

    const result = dispatchableRepository(issue, ["repo-a", "repo-b"], log);

    expect(result).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "issue linear:team-2 references unknown repository unknown-repo; configured workspace.knownRepositories: repo-a, repo-b",
    );
  });

  it("returns undefined without logging when the issue has no repository", () => {
    const issue = canonicalLinearIssue({
      naturalId: "team-3",
      repository: undefined,
      agent: undefined,
    });
    const log = vi.fn<(message: string) => void>();

    const result = dispatchableRepository(issue, ["repo-a", "repo-b"], log);

    expect(result).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("includes '(none)' in the warning when knownRepositories is empty", () => {
    const issue = canonicalLinearIssue({
      naturalId: "team-4",
      repository: "some-repo",
      agent: "claude",
    });
    const log = vi.fn<(message: string) => void>();

    const result = dispatchableRepository(issue, [], log);

    expect(result).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "issue linear:team-4 references unknown repository some-repo; configured workspace.knownRepositories: (none)",
    );
  });
});
