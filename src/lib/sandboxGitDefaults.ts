import { runCommandAsync } from "./commandRunner.ts";

/**
 * Git defaults applied inside every sandbox when `sandbox.gitDefaults`
 * is enabled (the default).
 *
 * - Disable GPG signing — robot commits inside the sandbox have no key
 *   and would otherwise fail or end up unsigned silently.
 * - Rewrite GitHub SSH URLs to HTTPS so push/fetch go through the `gh`
 *   credential helper (wired by `gh auth setup-git` after a successful
 *   `crew sandbox auth` github login), regardless of how the user
 *   originally cloned the repo on the host.
 *
 * `url.<base>.insteadOf` is multi-valued in git; `--unset-all` before
 * `--add` keeps the set identical across repeated runs instead of
 * appending duplicates.
 */
const GIT_DEFAULT_COMMANDS = [
  "git config --global commit.gpgsign false",
  "git config --global tag.gpgsign false",
  '(git config --global --unset-all url."https://github.com/".insteadOf 2>/dev/null || true)',
  'git config --global --add url."https://github.com/".insteadOf "git@github.com:"',
  'git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"',
].join(" && ");

interface ApplyGitDefaultsArguments {
  sandboxName: string;
}

/**
 * Apply the standard git defaults inside `sandboxName`. Idempotent —
 * safe to call on every `ensure`/`auth` run to repair drift.
 */
export async function applyGitDefaults(
  arguments_: ApplyGitDefaultsArguments,
  signal?: AbortSignal,
): Promise<void> {
  const options = signal === undefined ? {} : { signal };
  await runCommandAsync(
    "sbx",
    ["exec", arguments_.sandboxName, "sh", "-c", GIT_DEFAULT_COMMANDS],
    options,
  );
}
