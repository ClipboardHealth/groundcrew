import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import { buildBubblewrapArgs, buildBubblewrapPrefix } from "./bubblewrap.ts";
import type { BubblewrapPolicy } from "./config.ts";
import { readEnvironmentVariable } from "./util.ts";

function policy(overrides: Partial<BubblewrapPolicy> = {}): BubblewrapPolicy {
  return {
    allowedReadPaths: [],
    allowedWritePaths: [],
    envPass: [],
    network: "host",
    ...overrides,
  };
}

interface SetenvPair {
  name: string;
  value: string;
}

const BIND_FLAGS = new Set(["--bind", "--bind-try", "--ro-bind", "--ro-bind-try"]);

function collectBoundSources(args: readonly string[]): string[] {
  const sources: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (!BIND_FLAGS.has(args[index] ?? "")) {
      continue;
    }
    sources.push(args[index + 1] ?? "");
  }
  return sources;
}

function collectSetenvPairs(args: readonly string[]): SetenvPair[] {
  const pairs: SetenvPair[] = [];
  for (let index = 0; index < args.length - 2; index += 1) {
    if (args[index] !== "--setenv") {
      continue;
    }
    pairs.push({ name: args[index + 1] ?? "", value: args[index + 2] ?? "" });
  }
  return pairs;
}

describe(buildBubblewrapArgs, () => {
  it("requests user/pid/uts/ipc namespaces by default", () => {
    const args = buildBubblewrapArgs({
      policy: policy(),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
    });

    expect(args).toContain("--unshare-user");
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--unshare-uts");
    expect(args).toContain("--unshare-ipc");
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
  });

  it("does not bind $HOME or / under any policy", () => {
    const args = buildBubblewrapArgs({
      policy: policy({
        allowedReadPaths: ["/usr/local/share/data"],
        allowedWritePaths: ["~/.claude"],
      }),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
    });

    const boundSources = collectBoundSources(args);
    expect(boundSources).not.toContain("/");
    expect(boundSources).not.toContain("/home");
    expect(boundSources).not.toContain("/home/test");
  });

  it("mounts the worktree read-write at the same path", () => {
    const args = buildBubblewrapArgs({
      policy: policy(),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
    });

    const bindIndex = args.indexOf("--bind");
    expect(bindIndex).toBeGreaterThan(-1);
    expect(args[bindIndex + 1]).toBe("/work/repo-a-team-1");
    expect(args[bindIndex + 2]).toBe("/work/repo-a-team-1");
  });

  it("expands ~ in allowed paths against the provided home directory", () => {
    const args = buildBubblewrapArgs({
      policy: policy({
        allowedReadPaths: ["~/.gitconfig"],
        allowedWritePaths: ["~/.claude"],
      }),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
    });

    // Every `~/...` entry should be expanded — not passed verbatim.
    for (const arg of args) {
      expect(arg).not.toMatch(/^~/u);
    }
    expect(args).toContain("/home/test/.gitconfig");
    expect(args).toContain("/home/test/.claude");
  });

  it("rejects '~' alone (would mount the entire $HOME) even when listed in policy", () => {
    expect(() =>
      buildBubblewrapArgs({
        policy: policy({ allowedReadPaths: ["~"] }),
        worktreeDir: "/work/repo-a-team-1",
        homeDir: "/home/test",
      }),
    ).toThrow(/Refusing to bind \/home\/test/u);
  });

  it("rejects broad mounts (/, /home, /etc) even when listed in policy", () => {
    expect(() =>
      buildBubblewrapArgs({
        policy: policy({ allowedReadPaths: ["/"] }),
        worktreeDir: "/work/repo-a-team-1",
        homeDir: "/home/test",
      }),
    ).toThrow(/Refusing to bind \//u);

    expect(() =>
      buildBubblewrapArgs({
        policy: policy({ allowedWritePaths: ["/home"] }),
        worktreeDir: "/work/repo-a-team-1",
        homeDir: "/home/test",
      }),
    ).toThrow(/Refusing to bind \/home/u);

    expect(() =>
      buildBubblewrapArgs({
        policy: policy({ allowedReadPaths: ["/etc"] }),
        worktreeDir: "/work/repo-a-team-1",
        homeDir: "/home/test",
      }),
    ).toThrow(/Refusing to bind \/etc/u);
  });

  it("clears the environment and forwards only listed names that are set on the host", () => {
    setEnvironmentVariable("GROUNDCREW_TEST_SET", "set-value");
    setEnvironmentVariable("GROUNDCREW_TEST_PATH", "/some/path");
    deleteEnvironmentVariable("GROUNDCREW_TEST_UNSET");

    try {
      const args = buildBubblewrapArgs({
        policy: policy({
          envPass: ["GROUNDCREW_TEST_SET", "GROUNDCREW_TEST_UNSET", "GROUNDCREW_TEST_PATH"],
        }),
        worktreeDir: "/work/repo-a-team-1",
        homeDir: "/home/test",
      });

      expect(args).toContain("--clearenv");

      const setenvPairs = collectSetenvPairs(args);
      const names = setenvPairs.map((entry) => entry.name);
      expect(names).toContain("GROUNDCREW_TEST_SET");
      expect(names).not.toContain("GROUNDCREW_TEST_UNSET");
      expect(names).toContain("GROUNDCREW_TEST_PATH");
      expect(readEnvironmentVariable("GROUNDCREW_TEST_PATH")).toBe("/some/path");
    } finally {
      deleteEnvironmentVariable("GROUNDCREW_TEST_SET");
      deleteEnvironmentVariable("GROUNDCREW_TEST_PATH");
    }
  });

  it("injects HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY pointing at clearance when network is 'host'", () => {
    const args = buildBubblewrapArgs({
      policy: policy({ network: "host" }),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
    });

    const setenv = collectSetenvPairs(args);
    const byName = new Map(setenv.map((entry) => [entry.name, entry.value]));
    expect(byName.get("HTTP_PROXY")).toBe("http://127.0.0.1:19999");
    expect(byName.get("HTTPS_PROXY")).toBe("http://127.0.0.1:19999");
    expect(byName.get("ALL_PROXY")).toBe("http://127.0.0.1:19999");
    expect(byName.get("http_proxy")).toBe("http://127.0.0.1:19999");
    expect(byName.get("https_proxy")).toBe("http://127.0.0.1:19999");
    expect(byName.get("all_proxy")).toBe("http://127.0.0.1:19999");
    expect(byName.get("NO_PROXY")).toBe("localhost,127.0.0.1,::1");
    expect(byName.get("no_proxy")).toBe("localhost,127.0.0.1,::1");
  });

  it("honors a custom clearanceProxyUrl override", () => {
    const args = buildBubblewrapArgs({
      policy: policy({ network: "host" }),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
      clearanceProxyUrl: "http://127.0.0.1:29999",
    });

    const byName = new Map(collectSetenvPairs(args).map((entry) => [entry.name, entry.value]));
    expect(byName.get("HTTP_PROXY")).toBe("http://127.0.0.1:29999");
  });

  it("does not inject proxy env vars when network='none' (clearance unreachable)", () => {
    const args = buildBubblewrapArgs({
      policy: policy({ network: "none" }),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
    });

    const names = collectSetenvPairs(args).map((entry) => entry.name);
    expect(names).not.toContain("HTTP_PROXY");
    expect(names).not.toContain("HTTPS_PROXY");
    expect(names).not.toContain("NO_PROXY");
  });

  it("adds --unshare-net only when network='none'", () => {
    const withHost = buildBubblewrapArgs({
      policy: policy({ network: "host" }),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
    });
    expect(withHost).not.toContain("--unshare-net");

    const withNone = buildBubblewrapArgs({
      policy: policy({ network: "none" }),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
    });
    expect(withNone).toContain("--unshare-net");
  });

  it("uses --ro-bind-try / --bind-try so missing optional paths don't fail the launch", () => {
    const args = buildBubblewrapArgs({
      policy: policy({
        allowedReadPaths: ["/opt/missing-ro"],
        allowedWritePaths: ["/opt/missing-rw"],
      }),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
    });

    const roIndex = args.indexOf("/opt/missing-ro");
    expect(args[roIndex - 1]).toBe("--ro-bind-try");

    const rwIndex = args.indexOf("/opt/missing-rw");
    expect(args[rwIndex - 1]).toBe("--bind-try");
  });

  it("chdir's into the worktree so the agent doesn't inherit the host CWD", () => {
    const args = buildBubblewrapArgs({
      policy: policy(),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
    });

    const index = args.indexOf("--chdir");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe("/work/repo-a-team-1");
  });
});

describe(buildBubblewrapPrefix, () => {
  it("produces a shell-quoted prefix that starts with `bwrap`", () => {
    const prefix = buildBubblewrapPrefix({
      policy: policy({ envPass: [] }),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
    });

    expect(prefix.startsWith("'bwrap' ")).toBe(true);
  });

  it("honors a custom bwrap binary path", () => {
    const prefix = buildBubblewrapPrefix({
      policy: policy({ envPass: [] }),
      worktreeDir: "/work/repo-a-team-1",
      homeDir: "/home/test",
      bwrapBinary: "/usr/local/bin/bwrap",
    });

    expect(prefix.startsWith("'/usr/local/bin/bwrap' ")).toBe(true);
  });

  it("survives single quotes in the worktree path", () => {
    const prefix = buildBubblewrapPrefix({
      policy: policy({ envPass: [] }),
      worktreeDir: "/work/it's-fine",
      homeDir: "/home/test",
    });

    expect(prefix).toContain(String.raw`'/work/it'\''s-fine'`);
  });
});
