export function fileErrorCode(error: unknown): string | undefined {
  /* v8 ignore next @preserve -- fs failures are Error objects carrying a string code */
  if (!(error instanceof Error) || !errorHasCode(error)) {
    return undefined;
  }
  return String(error.code);
}

export function isFileErrorCode(error: unknown, code: string): boolean {
  return fileErrorCode(error) === code;
}

function errorHasCode(error: Error): error is Error & { code: unknown } {
  return Object.hasOwn(error, "code");
}

export function describeFileError(error: unknown): string {
  const code = fileErrorCode(error);
  /* v8 ignore next @preserve -- callers pass filesystem Error objects; fallback is defensive */
  const message = error instanceof Error ? error.message : String(error);
  /* v8 ignore next @preserve -- filesystem Error objects carry a code; fallback is defensive */
  return code === undefined ? message : `${code}: ${message}`;
}
