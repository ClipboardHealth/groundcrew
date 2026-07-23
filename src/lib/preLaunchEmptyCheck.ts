/**
 * Emit POSIX-shell lines that WARN (to stderr, never abort) when a
 * `preLaunchEnv` name resolves to an empty string after `preLaunch` runs.
 * Length-0 is the reliable tell for the `export VAR="$(cat missing-file)"`
 * failure mode: `export` masks the substitution's non-zero exit status, so
 * `set -e` and exit-code checks do not catch it.
 *
 * Warn-only is deliberate — a hard-abort mode is a separate opt-in, so the
 * chain (prompt read, prompt-dir cleanup, exec) must not be short-circuited
 * by an empty value here.
 *
 * Returns `[]` for an empty input list so callers can splat unconditionally
 * into their `&&` chain.
 *
 * Caveat: the check reads the shell's post-preLaunch view of the var. On the
 * safehouse chain (`hostPreLaunchSourceAndReadPrompt`) the caller unsets each
 * `preLaunchEnv` name before running `preLaunch`, so the check truly reflects
 * what `preLaunch` produced. On the unwrapped-host chain
 * (`preLaunchPromptAndExec`) no unset happens first, so a value inherited
 * from the parent shell can survive `preLaunch` and mask a failed `export`.
 * That asymmetry is a property of the runners; closing it requires an env
 * scrub on the runner=none path, tracked as a follow-up.
 *
 * Names must be POSIX identifiers (`[A-Za-z_][A-Za-z0-9_]*`); groundcrew's
 * `validatePreLaunchEnv` in `src/lib/config.ts` enforces that, so no shell
 * escaping is done here.
 */
export function buildPreLaunchEmptyCheckLines(names: readonly string[]): string[] {
  if (names.length === 0) {
    return [];
  }
  return [...new Set(names)].map(
    (name) =>
      `if [ -z "\${${name}-}" ]; then echo "preLaunchEnv: ${name} is empty after preLaunch (value length 0)" >&2; fi`,
  );
}
