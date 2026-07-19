/**
 * Secret resolution for source invocation. Core resolves the env NAMES a
 * manifest declares to values; it never stores or logs the values (contracts
 * §4.1). Values come from the parent environment or an optional dotenv-format
 * `secrets.env` file — parsed here with no new dependency (design: NO new deps).
 */

/** Resolves a declared secret name to its value, or `undefined` when unknown. */
export interface SecretsResolver {
  resolve(name: string): string | undefined;
}

/**
 * Builds a resolver over an environment map and an optional dotenv file. The
 * parent environment wins over the file so an explicit export overrides the
 * on-disk secrets store (decision: contracts leave precedence open).
 */
export function createSecretsResolver(input: {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly secretsFileContents?: string;
}): SecretsResolver {
  const environment = input.environment ?? {};
  const fromFile =
    input.secretsFileContents === undefined ? {} : parseDotenv(input.secretsFileContents);

  return {
    resolve(name: string): string | undefined {
      const fromEnvironment = environment[name];
      if (fromEnvironment !== undefined) {
        return fromEnvironment;
      }

      return fromFile[name];
    },
  };
}

/**
 * Parses dotenv-format text into a flat map. Supports `KEY=value`, `export KEY=`,
 * `#` comments, blank lines, and single/double-quoted values (quotes stripped;
 * double quotes honor `\n`/`\t` escapes). Deliberately small — the secrets file
 * is hand-authored, not a general dotenv document.
 */
export function parseDotenv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = withoutExport.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = withoutExport.slice(0, equalsIndex).trim();
    const value = withoutExport.slice(equalsIndex + 1).trim();
    result[key] = unquote(value);
  }

  return result;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll("\\n", "\n").replaceAll("\\t", "\t");
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
}
