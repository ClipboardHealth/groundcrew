import { execa } from "execa";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const WORKSPACE_VISIBILITY_ATTEMPTS = 40;
const WORKSPACE_VISIBILITY_INTERVAL_MILLISECONDS = 50;
const PRESENTATION_ID_ENVIRONMENT_KEY = "GROUNDCREW_PRESENTATION_ID";

const WorkspaceListSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.string(),
    }),
  ),
});

export interface PresenterOpenInput {
  readonly presentationId: string;
  readonly displayName?: string | undefined;
  readonly workingDirectory: string;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly status?: string | undefined;
}

export interface PresentedWorkspace {
  readonly presentationId: string;
  readonly presenterHandle: string;
}

export interface PresentationTarget {
  readonly presentationId: string;
  readonly presenterHandle?: string | undefined;
}

export interface Presenter {
  open(input: PresenterOpenInput): Promise<PresentedWorkspace>;
  probe(): Promise<{
    readonly available: boolean;
    readonly workspaces: readonly PresentedWorkspace[];
  }>;
  close(input: PresentationTarget): Promise<void>;
  accessHint(input: PresentationTarget): Promise<string | undefined>;
  setStatus?(input: {
    readonly presentationId: string;
    readonly presenterHandle?: string | undefined;
    readonly text: string;
    readonly color?: string | undefined;
  }): Promise<void>;
}

export function createPresenter(input: {
  readonly name: "cmux";
  readonly environment: NodeJS.ProcessEnv;
}): Presenter {
  return new CmuxPresenter({ environment: input.environment });
}

export class CmuxPresenter implements Presenter {
  readonly #environment: NodeJS.ProcessEnv;

  public constructor(input: { readonly environment: NodeJS.ProcessEnv }) {
    this.#environment = input.environment;
  }

  public async open(input: PresenterOpenInput): Promise<PresentedWorkspace> {
    const arguments_ = [
      "new-workspace",
      "--name",
      input.displayName ?? input.presentationId,
      "--cwd",
      input.workingDirectory,
      "--command",
      input.command.map(shellQuote).join(" "),
    ];
    const workspaceEnvironment = {
      ...input.environment,
      [PRESENTATION_ID_ENVIRONMENT_KEY]: input.presentationId,
    };
    for (const [key, value] of Object.entries(workspaceEnvironment)) {
      arguments_.push("--env", `${key}=${value}`);
    }
    const result = await execa("cmux", arguments_, { env: this.#environment, reject: false });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "cmux failed to create workspace");
    }
    const workspace = await this.waitUntilVisible({ presentationId: input.presentationId });
    if (input.status !== undefined) {
      await this.setWorkspaceStatus({ text: input.status, workspaceId: workspace.presenterHandle });
    }
    return workspace;
  }

  public async probe(): Promise<{
    readonly available: boolean;
    readonly workspaces: readonly PresentedWorkspace[];
  }> {
    const workspaces = await this.listWorkspaces();
    if (workspaces === undefined) {
      return { available: false, workspaces: [] };
    }
    const presentations = await Promise.all(
      workspaces.map(
        async (workspace) => await this.readPresentation({ presenterHandle: workspace.id }),
      ),
    );
    if (presentations.some((presentation) => !presentation.available)) {
      return { available: false, workspaces: [] };
    }
    return {
      available: true,
      workspaces: presentations.flatMap((presentation) =>
        presentation.workspace === undefined ? [] : [presentation.workspace],
      ),
    };
  }

  public async close(input: PresentationTarget): Promise<void> {
    const workspace = await this.resolve(input);
    if (workspace === undefined) {
      return;
    }
    const result = await execa(
      "cmux",
      ["close-workspace", "--workspace", workspace.presenterHandle],
      {
        env: this.#environment,
        reject: false,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "cmux close failed");
    }
  }

  public async accessHint(input: PresentationTarget): Promise<string | undefined> {
    const workspace = await this.resolve(input);
    return workspace === undefined ? undefined : `cmux workspace ${workspace.presenterHandle}`;
  }

  public async setStatus(input: {
    readonly presentationId: string;
    readonly presenterHandle?: string | undefined;
    readonly text: string;
    readonly color?: string | undefined;
  }): Promise<void> {
    const workspace = await this.resolve(input);
    if (workspace === undefined) {
      return;
    }
    await this.setWorkspaceStatus({
      color: input.color,
      text: input.text,
      workspaceId: workspace.presenterHandle,
    });
  }

  private async setWorkspaceStatus(input: {
    readonly workspaceId: string;
    readonly text: string;
    readonly color?: string | undefined;
  }): Promise<void> {
    const progress = ["complete", "delivered", "failed", "stopped"].includes(input.text)
      ? "1"
      : "0.5";
    const result = await execa(
      "cmux",
      ["set-progress", progress, "--workspace", input.workspaceId, "--label", input.text],
      { env: this.#environment, reject: false },
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "cmux status failed");
    }
  }

  private async waitUntilVisible(input: {
    readonly presentationId: string;
  }): Promise<PresentedWorkspace> {
    let previousPresenterHandle: string | undefined;
    for (let attempt = 0; attempt < WORKSPACE_VISIBILITY_ATTEMPTS; attempt += 1) {
      // cmux may acknowledge creation before the workspace reaches its list API.
      // eslint-disable-next-line no-await-in-loop
      const workspace = await this.resolve(input);
      if (workspace !== undefined && workspace.presenterHandle === previousPresenterHandle) {
        return workspace;
      }
      previousPresenterHandle = workspace?.presenterHandle;
      // eslint-disable-next-line no-await-in-loop
      await delay(WORKSPACE_VISIBILITY_INTERVAL_MILLISECONDS);
    }
    throw new Error(
      `cmux presentation ${input.presentationId} did not become visible after creation`,
    );
  }

  private async resolve(input: PresentationTarget): Promise<PresentedWorkspace | undefined> {
    if (input.presenterHandle !== undefined) {
      const workspaces = await this.listWorkspaces();
      if (workspaces?.some((workspace) => workspace.id === input.presenterHandle)) {
        return {
          presentationId: input.presentationId,
          presenterHandle: input.presenterHandle,
        };
      }
    }
    const probe = await this.probe();
    return probe.workspaces.find((workspace) => workspace.presentationId === input.presentationId);
  }

  private async readPresentation(input: { readonly presenterHandle: string }): Promise<{
    readonly available: boolean;
    readonly workspace?: PresentedWorkspace | undefined;
  }> {
    const result = await execa("cmux", ["workspace", "env", input.presenterHandle], {
      env: { ...this.#environment, CMUX_QUIET: "1" },
      reject: false,
    });
    if (result.exitCode !== 0) {
      return { available: false };
    }
    const prefix = `${PRESENTATION_ID_ENVIRONMENT_KEY}=`;
    const entry = result.stdout.split("\n").find((line) => line.startsWith(prefix));
    return {
      available: true,
      workspace:
        entry === undefined
          ? undefined
          : {
              presentationId: entry.slice(prefix.length),
              presenterHandle: input.presenterHandle,
            },
    };
  }

  private async listWorkspaces(): Promise<
    | readonly {
        readonly id: string;
      }[]
    | undefined
  > {
    const result = await execa("cmux", ["--json", "list-workspaces"], {
      env: { ...this.#environment, CMUX_QUIET: "1" },
      reject: false,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    try {
      const parsed = WorkspaceListSchema.safeParse(JSON.parse(result.stdout));
      return parsed.success ? parsed.data.workspaces : undefined;
    } catch {
      return undefined;
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
