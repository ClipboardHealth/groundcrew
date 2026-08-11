import { execa } from "execa";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const WORKSPACE_VISIBILITY_ATTEMPTS = 40;
const WORKSPACE_VISIBILITY_INTERVAL_MILLISECONDS = 50;

const WorkspaceListSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().nullable().optional(),
    }),
  ),
});

export interface PresenterOpenInput {
  readonly name: string;
  readonly displayName?: string | undefined;
  readonly workingDirectory: string;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly status?: string | undefined;
}

export interface PresentedWorkspace {
  readonly name: string;
  readonly description?: string | undefined;
}

export interface Presenter {
  open(input: PresenterOpenInput): Promise<void>;
  probe(): Promise<{
    readonly available: boolean;
    readonly workspaces: readonly PresentedWorkspace[];
  }>;
  close(input: { readonly name: string }): Promise<void>;
  accessHint(input: { readonly name: string }): Promise<string | undefined>;
  setStatus?(input: {
    readonly name: string;
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

  public async open(input: PresenterOpenInput): Promise<void> {
    const arguments_ = [
      "new-workspace",
      "--name",
      input.displayName ?? input.name,
      "--description",
      `groundcrew:${input.environment["GROUNDCREW_TASK_ID"] ?? input.name}`,
      "--cwd",
      input.workingDirectory,
      "--command",
      input.command.map(shellQuote).join(" "),
    ];
    for (const [key, value] of Object.entries(input.environment)) {
      arguments_.push("--env", `${key}=${value}`);
    }
    const result = await execa("cmux", arguments_, { env: this.#environment, reject: false });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "cmux failed to create workspace");
    }
    const workspace = await this.waitUntilVisible({ name: input.name });
    if (input.status !== undefined) {
      await this.setWorkspaceStatus({ text: input.status, workspaceId: workspace.id });
    }
  }

  public async probe(): Promise<{
    readonly available: boolean;
    readonly workspaces: readonly PresentedWorkspace[];
  }> {
    const workspaces = await this.listWorkspaces();
    if (workspaces === undefined) {
      return { available: false, workspaces: [] };
    }
    return {
      available: true,
      workspaces: workspaces.map((workspace) => ({
        description: workspace.description ?? undefined,
        name: workspace.title,
      })),
    };
  }

  public async close(input: { readonly name: string }): Promise<void> {
    const workspace = await this.resolve({ name: input.name });
    if (workspace === undefined) {
      return;
    }
    const result = await execa("cmux", ["close-workspace", "--workspace", workspace.id], {
      env: this.#environment,
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "cmux close failed");
    }
  }

  public async accessHint(input: { readonly name: string }): Promise<string | undefined> {
    const workspace = await this.resolve({ name: input.name });
    return workspace === undefined ? undefined : `cmux workspace ${workspace.id}`;
  }

  public async setStatus(input: {
    readonly name: string;
    readonly text: string;
    readonly color?: string | undefined;
  }): Promise<void> {
    const workspace = await this.resolve({ name: input.name });
    if (workspace === undefined) {
      return;
    }
    await this.setWorkspaceStatus({
      color: input.color,
      text: input.text,
      workspaceId: workspace.id,
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
    readonly name: string;
  }): Promise<{ readonly id: string; readonly title: string }> {
    let previousWorkspaceId: string | undefined;
    for (let attempt = 0; attempt < WORKSPACE_VISIBILITY_ATTEMPTS; attempt += 1) {
      // cmux may acknowledge creation before the workspace reaches its list API.
      // eslint-disable-next-line no-await-in-loop
      const workspace = await this.resolve(input);
      if (workspace !== undefined && workspace.id === previousWorkspaceId) {
        return workspace;
      }
      previousWorkspaceId = workspace?.id;
      // eslint-disable-next-line no-await-in-loop
      await delay(WORKSPACE_VISIBILITY_INTERVAL_MILLISECONDS);
    }
    throw new Error(`cmux workspace ${input.name} did not become visible after creation`);
  }

  private async resolve(input: {
    readonly name: string;
  }): Promise<{ readonly id: string; readonly title: string } | undefined> {
    const workspaces = await this.listWorkspaces();
    return workspaces?.find(
      (workspace) => workspace.title === input.name || workspace.description === input.name,
    );
  }

  private async listWorkspaces(): Promise<
    | readonly {
        readonly id: string;
        readonly title: string;
        readonly description?: string | null | undefined;
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
