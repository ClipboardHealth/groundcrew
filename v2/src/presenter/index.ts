import { execa } from "execa";
import { z } from "zod";

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
    if (input.status !== undefined) {
      await this.setStatus({ name: input.name, text: input.status });
    }
  }

  public async probe(): Promise<{
    readonly available: boolean;
    readonly workspaces: readonly PresentedWorkspace[];
  }> {
    const result = await execa("cmux", ["--json", "list-workspaces"], {
      env: { ...this.#environment, CMUX_QUIET: "1" },
      reject: false,
    });
    if (result.exitCode !== 0) {
      return { available: false, workspaces: [] };
    }
    const parsed = WorkspaceListSchema.safeParse(JSON.parse(result.stdout));
    if (!parsed.success) {
      return { available: false, workspaces: [] };
    }
    return {
      available: true,
      workspaces: parsed.data.workspaces.map((workspace) => ({
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
    const progress = ["complete", "delivered", "failed", "stopped"].includes(input.text)
      ? "1"
      : "0.5";
    const result = await execa(
      "cmux",
      ["set-progress", progress, "--workspace", workspace.id, "--label", input.text],
      { env: this.#environment, reject: false },
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "cmux status failed");
    }
  }

  private async resolve(input: {
    readonly name: string;
  }): Promise<{ readonly id: string; readonly title: string } | undefined> {
    const result = await execa("cmux", ["--json", "list-workspaces"], {
      env: { ...this.#environment, CMUX_QUIET: "1" },
      reject: false,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const parsed = WorkspaceListSchema.safeParse(JSON.parse(result.stdout));
    if (!parsed.success) {
      return undefined;
    }
    return parsed.data.workspaces.find(
      (workspace) => workspace.title === input.name || workspace.description === input.name,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
