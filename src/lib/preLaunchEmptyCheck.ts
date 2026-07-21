/**
 * Emit POSIX-shell lines that warn (to stderr) when a `preLaunchEnv` name
 * resolves to an empty string after `preLaunch` runs. Length-0 is the
 * reliable tell for the `export VAR="$(cat missing-file)"` failure mode
 * (bash's `export` builtin masks the substitution's non-zero exit status,
 * so `set -e` and exit-code checks do not catch it).
 *
 * Returns `[]` for an empty input list so callers can splat unconditionally
 * into their `&&` chain.
 *
 * The generated snippet warns and continues — it never aborts. An opt-in
 * abort mode is a follow-up, not part of this contract.
 *
 * Each emitted line is a `{ …; }` compound so it participates properly in
 * the outer `&&` chain: a preceding `preLaunch` failure still short-circuits
 * the chain instead of falling through to the check (a bare `if … fi` link
 * would not — `;` does not short-circuit `&&`).
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
      `{ if [ -z "\${${name}-}" ]; then echo "preLaunchEnv: ${name} is empty after preLaunch (value length 0)" >&2; fi; }`,
  );
}
