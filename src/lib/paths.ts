import { homedir } from "node:os";
import path from "node:path";

export function expandHome(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return path.resolve(homedir(), p.slice(2));
  }
  return p;
}
