import { createServer, type AddressInfo, type Server } from "node:net";

import type { RunCommandOptions } from "./commandRunner.ts";
import type { RemoteRunnerConfig } from "./config.ts";
import {
  getRemoteRunnerProvider,
  remoteConfigWithRunnerName,
  spriteRemoteRunnerProvider,
} from "./spriteRemoteRunnerProvider.ts";

type RunCommandAsyncMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => Promise<string | undefined>;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandAsyncMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test mock records calls across runCommandAsync overloads.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

function remoteConfig(overrides: Partial<RemoteRunnerConfig> = {}): RemoteRunnerConfig {
  return {
    ...remoteConfigWithRunnerName("crew-special"),
    owner: "Acme",
    repoRoot: "/srv/repos/",
    worktreeRoot: "/srv/worktrees/",
    secretNames: ["NPM_TOKEN"],
    ...overrides,
  };
}

async function listenOnLoopback(port = 0): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { port: portFromAddress(server.address()), server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function portFromAddress(address: AddressInfo | string | null): number {
  if (typeof address === "object" && address !== null) {
    return address.port;
  }
  throw new Error(`Expected TCP server address, got ${String(address)}.`);
}

describe("Sprite remote runner provider", () => {
  afterEach(() => {
    vi.useRealTimers();
    runCommandMock.mockReset();
  });

  it("detects existing runners by exact escaped runner name", async () => {
    const config = remoteConfig({ runnerName: "crew.special+1" });
    runCommandMock.mockResolvedValue(
      "NAME STATUS\ncrew.special+1 running\ncrew-special-2 running\n",
    );

    const actual = await spriteRemoteRunnerProvider.runnerExists(config);

    expect(actual).toBe(true);
    expect(runCommandMock).toHaveBeenCalledWith("sprite", ["list", "--sprite", "crew.special+1"]);
  });

  it("returns false when the configured runner is absent", async () => {
    const config = remoteConfig({ runnerName: "crew-special-1" });
    runCommandMock.mockResolvedValue("NAME STATUS\ncrew-special-2 running\n");

    const actual = await spriteRemoteRunnerProvider.runnerExists(config);

    expect(actual).toBe(false);
  });

  it("creates runners with inherited stdio and no timeout", async () => {
    const config = remoteConfig();
    runCommandMock.mockResolvedValue("");

    await spriteRemoteRunnerProvider.createRunner(config);

    expect(runCommandMock).toHaveBeenCalledWith(
      "sprite",
      ["create", "--skip-console", "crew-special"],
      { stdio: "inherit", timeoutMs: 0 },
    );
  });

  it("starts and closes Sprite port proxies", async () => {
    const config = remoteConfig();
    const listener = await listenOnLoopback();
    runCommandMock.mockImplementation(
      async (_command, _arguments, options) =>
        await new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { signal: "SIGINT" }));
          });
        }),
    );

    try {
      const proxy = await spriteRemoteRunnerProvider.startPortProxy(config, listener.port);
      await proxy.close();
    } finally {
      await closeServer(listener.server);
    }

    expect(runCommandMock).toHaveBeenCalledWith(
      "sprite",
      ["proxy", "-s", "crew-special", String(listener.port)],
      expect.objectContaining({ stdio: "inherit", timeoutMs: 0 }),
    );
    expect(runCommandMock.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("allows Sprite port proxy commands to exit cleanly during close", async () => {
    const config = remoteConfig();
    const listener = await listenOnLoopback();
    runCommandMock.mockImplementation(
      async (_command, _arguments, options) =>
        await new Promise<string>((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            resolve("");
          });
        }),
    );

    try {
      const proxy = await spriteRemoteRunnerProvider.startPortProxy(config, listener.port);

      await expect(proxy.close()).resolves.toBeUndefined();
    } finally {
      await closeServer(listener.server);
    }
  });

  it("waits for Sprite port proxies to accept connections before resolving", async () => {
    const config = remoteConfig();
    const { port, server: reservedServer } = await listenOnLoopback();
    await closeServer(reservedServer);
    let didResolve = false;
    runCommandMock.mockImplementation(
      async (_command, _arguments, options) =>
        await new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { signal: "SIGINT" }));
          });
        }),
    );

    const proxyPromise = spriteRemoteRunnerProvider.startPortProxy(config, port).then((proxy) => {
      didResolve = true;
      return proxy;
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    const listener = await listenOnLoopback(port);

    try {
      expect(didResolve).toBe(false);
      const proxy = await proxyPromise;
      expect(didResolve).toBe(true);
      await proxy.close();
    } finally {
      await closeServer(listener.server);
    }
  });

  it("surfaces Sprite port proxy startup failures before readiness", async () => {
    const config = remoteConfig();
    const { port, server: reservedServer } = await listenOnLoopback();
    await closeServer(reservedServer);
    runCommandMock.mockRejectedValue(new Error("missing sprite auth"));

    await expect(spriteRemoteRunnerProvider.startPortProxy(config, port)).rejects.toThrow(
      /missing sprite auth/,
    );
  });

  it("surfaces Sprite port proxy exits before readiness", async () => {
    const config = remoteConfig();
    const { port, server: reservedServer } = await listenOnLoopback();
    await closeServer(reservedServer);
    runCommandMock.mockResolvedValue("");

    await expect(spriteRemoteRunnerProvider.startPortProxy(config, port)).rejects.toThrow(
      /Sprite proxy exited before it was closed/,
    );
  });

  it("times out when Sprite port proxies never accept connections", async () => {
    const config = remoteConfig();
    const { port, server: reservedServer } = await listenOnLoopback();
    await closeServer(reservedServer);
    vi.useFakeTimers();
    runCommandMock.mockImplementation(
      async (_command, _arguments, options) =>
        await new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { signal: "SIGINT" }));
          });
        }),
    );

    const proxyPromise = spriteRemoteRunnerProvider.startPortProxy(config, port);
    await vi.advanceTimersByTimeAsync(6000);

    await expect(proxyPromise).rejects.toThrow(/Timed out waiting for Sprite proxy/);
  });

  it("surfaces Sprite port proxy failures that are not caused by close", async () => {
    const config = remoteConfig();
    const listener = await listenOnLoopback();
    runCommandMock.mockImplementation(
      async (_command, _arguments, options) =>
        await new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("proxy failed", { cause: { signal: "SIGTERM" } }));
          });
        }),
    );

    try {
      const proxy = await spriteRemoteRunnerProvider.startPortProxy(config, listener.port);

      await expect(proxy.close()).rejects.toThrow(/proxy failed/);
    } finally {
      await closeServer(listener.server);
    }
  });

  it("surfaces Sprite port proxy failures with empty causes", async () => {
    const config = remoteConfig();
    const listener = await listenOnLoopback();
    runCommandMock.mockImplementation(
      async (_command, _arguments, options) =>
        await new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("proxy failed", { cause: null }));
          });
        }),
    );

    try {
      const proxy = await spriteRemoteRunnerProvider.startPortProxy(config, listener.port);

      await expect(proxy.close()).rejects.toThrow(/proxy failed/);
    } finally {
      await closeServer(listener.server);
    }
  });

  it("runs captured remote commands with files, working directory, and caller options", async () => {
    const config = remoteConfig();
    runCommandMock.mockResolvedValue("ok");

    const actual = await spriteRemoteRunnerProvider.runCommand({
      config,
      remoteArguments: ["bash", "-lc", "pwd"],
      files: [{ localPath: "/tmp/prompt.txt", remotePath: "/remote/prompt.txt" }],
      workingDirectory: "/srv/repos/core-utils",
      options: { timeoutMs: 30_000 },
    });

    expect(actual).toBe("ok");
    expect(runCommandMock).toHaveBeenCalledWith(
      "sprite",
      [
        "exec",
        "-s",
        "crew-special",
        "--file",
        "/tmp/prompt.txt:/remote/prompt.txt",
        "--dir",
        "/srv/repos/core-utils",
        "--",
        "bash",
        "-lc",
        "pwd",
      ],
      { timeoutMs: 30_000 },
    );
  });

  it("preserves explicit captured stdio options for remote commands", async () => {
    const config = remoteConfig();
    runCommandMock.mockResolvedValue("ok\n");

    await spriteRemoteRunnerProvider.runCommand({
      config,
      remoteArguments: ["printf", "ok"],
      options: { stdio: "captured", trim: false },
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "sprite",
      ["exec", "-s", "crew-special", "--", "printf", "ok"],
      { stdio: "captured", trim: false },
    );
  });

  it("runs TTY commands through sprite exec with inherited stdio", async () => {
    const config = remoteConfig();
    runCommandMock.mockResolvedValue("");

    await spriteRemoteRunnerProvider.runTtyCommand({
      config,
      remoteArguments: ["claude", "start"],
      files: [{ localPath: "/tmp/prompt.txt", remotePath: "/remote/prompt.txt" }],
      workingDirectory: "/srv/repos/core-utils",
      options: { timeoutMs: 15_000 },
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "sprite",
      [
        "exec",
        "--tty",
        "-s",
        "crew-special",
        "--file",
        "/tmp/prompt.txt:/remote/prompt.txt",
        "--dir",
        "/srv/repos/core-utils",
        "--",
        "claude",
        "start",
      ],
      { stdio: "inherit", timeoutMs: 15_000 },
    );
  });

  it("builds TTY commands without optional file uploads or working directory", () => {
    const config = remoteConfig();

    const actual = spriteRemoteRunnerProvider.buildTtyCommand({
      config,
      remoteArguments: ["pwd"],
    });

    expect(actual).toBe("sprite exec --tty -s 'crew-special' -- 'pwd'");
  });

  it("creates remote worktrees under provider-owned repository and worktree roots", async () => {
    const config = remoteConfig();
    const controller = new AbortController();
    runCommandMock.mockResolvedValue("");

    const actual = await spriteRemoteRunnerProvider.createWorktree({
      config,
      repository: "tools.git",
      ticket: "GC-12",
      branchName: "feature/remote-runner",
      baseBranch: "main",
      signal: controller.signal,
    });

    expect(actual).toStrictEqual({
      remoteRepoDir: "/srv/repos/Acme--tools",
      remoteWorktreeDir: "/srv/worktrees/Acme--tools-GC-12",
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      "sprite",
      [
        "exec",
        "-s",
        "crew-special",
        "--",
        "bash",
        "-lc",
        expect.stringContaining("gh repo clone 'Acme/tools.git'"),
      ],
      { signal: controller.signal, stdio: "inherit", timeoutMs: 0 },
    );
    const script = runCommandMock.mock.calls[0]?.[1].at(-1);
    expect(script).toContain("repo_dir='/srv/repos/Acme--tools'");
    expect(script).toContain("worktree_dir='/srv/worktrees/Acme--tools-GC-12'");
    expect(script).toContain('git -C "$repo_dir" worktree add -b "$branch"');
  });

  it("keeps owner-qualified repositories distinct in remote directory names", async () => {
    const config = remoteConfig();
    runCommandMock.mockResolvedValue("");

    const actual = await spriteRemoteRunnerProvider.createWorktree({
      config,
      repository: "TeamB/tools.git",
      ticket: "GC-12",
      branchName: "feature/remote-runner",
      baseBranch: "main",
    });

    expect(actual).toStrictEqual({
      remoteRepoDir: "/srv/repos/TeamB--tools",
      remoteWorktreeDir: "/srv/worktrees/TeamB--tools-GC-12",
    });
    const script = runCommandMock.mock.calls[0]?.[1].at(-1);
    expect(script).toContain("gh repo clone 'TeamB/tools.git'");
    expect(script).toContain("repo_dir='/srv/repos/TeamB--tools'");
  });

  it("rejects unsafe ticket path components before creating remote worktrees", async () => {
    const config = remoteConfig();

    await expect(
      spriteRemoteRunnerProvider.createWorktree({
        config,
        repository: "tools.git",
        ticket: "GC/../../other",
        branchName: "feature/remote-runner",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/Invalid ticket for remote worktree path/);
    await expect(
      spriteRemoteRunnerProvider.createWorktree({
        config,
        repository: "tools.git",
        ticket: String.raw`GC\12`,
        branchName: "feature/remote-runner",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/Invalid ticket for remote worktree path/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("removes remote worktrees through the entry runner and repository", async () => {
    const config = remoteConfig();
    runCommandMock.mockResolvedValue("");

    await spriteRemoteRunnerProvider.removeWorktree({
      config,
      entry: {
        branchName: "feature/remote-runner",
        dir: "/srv/worktrees/tools-GC-12",
        remoteRepoDir: "/srv/repos/tools",
        remoteRunnerName: "crew-special",
      },
      force: true,
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "sprite",
      [
        "exec",
        "-s",
        "crew-special",
        "--",
        "bash",
        "-lc",
        expect.stringContaining("git -C '/srv/repos/tools' worktree remove --force"),
      ],
      { stdio: "inherit", timeoutMs: 0 },
    );
  });

  it("rejects incomplete remote worktree entries before shelling out", async () => {
    const config = remoteConfig();

    await expect(
      spriteRemoteRunnerProvider.removeWorktree({
        config,
        entry: {
          branchName: "feature/remote-runner",
          dir: "/srv/worktrees/tools-GC-12",
          remoteRepoDir: "/srv/repos/tools",
        },
        force: false,
      }),
    ).rejects.toThrow(/missing remoteRunnerName/);
    await expect(
      spriteRemoteRunnerProvider.removeWorktree({
        config,
        entry: {
          branchName: "feature/remote-runner",
          dir: "/srv/worktrees/tools-GC-12",
          remoteRunnerName: "crew-special",
        },
        force: false,
      }),
    ).rejects.toThrow(/missing remoteRepoDir/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });
});

describe(getRemoteRunnerProvider, () => {
  it("returns the Sprite provider for the configured provider name", () => {
    expect(getRemoteRunnerProvider("sprite")).toBe(spriteRemoteRunnerProvider);
  });

  it("rejects unknown provider names at runtime", () => {
    expect(() => {
      Reflect.apply(getRemoteRunnerProvider, undefined, ["other"]);
    }).toThrow(/Unknown remote provider/);
  });
});
