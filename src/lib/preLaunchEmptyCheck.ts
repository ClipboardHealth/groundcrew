/**
 * Emit POSIX-shell lines that warn (to stderr) when a `preLaunchEnv` name
 * resolves to an empty string after `preLaunch` runs. Length-0 is the
 * reliable tell for the `export VAR="$(cat missing-file)"` failure mode:
 * `export` masks the substitution's non-zero exit status, so `set -e` and
 * exit-code checks do not catch it.
 *
 * Returns `[]` for an empty input list so callers can splat unconditionally
 * into their `&&` chain.
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
