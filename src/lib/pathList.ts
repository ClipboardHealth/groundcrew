import path from "node:path";

export function splitPathList(value: string | undefined): string[] {
  const paths: string[] = [];
  for (const entry of value?.split(path.delimiter) ?? []) {
    const pathEntry = entry.trim();
    if (pathEntry.length > 0) {
      paths.push(pathEntry);
    }
  }
  return paths;
}
