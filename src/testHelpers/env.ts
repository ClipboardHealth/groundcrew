export function setEnvironmentVariable(name: string, value: string): void {
  process.env[name] = value;
}

export function deleteEnvironmentVariable(name: string): void {
  Reflect.deleteProperty(process.env, name);
}

export function snapshotEnvironmentVariables(): Record<string, string | undefined> {
  return { ...process.env };
}
