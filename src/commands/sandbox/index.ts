import { loadConfig } from "../../lib/config.ts";
import { runAuth } from "./auth.ts";
import { runList } from "./inspect.ts";
import { runEnsure, runRegenerate, runRemove } from "./lifecycle.ts";

const USAGE = [
  "Usage: crew sandbox <verb> [...args]",
  "",
  "Verbs:",
  "  list                      Show every groundcrew-owned sandbox known to sbx",
  "  ensure [<model>]          Provision the sandbox for one model, or all when omitted",
  "  regenerate <model>|--all  Tear down and recreate from current template/kits",
  "  auth <model>|--all        Open a checkbox picker of every tool available in <model>'s",
  "                            sandbox and run the login flow for each one you select;",
  "                            --all loops through every configured sandbox in turn",
  "  rm <model>                Remove the sandbox for a model",
].join("\n");

export async function sandboxCli(argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    throw new Error(USAGE);
  }
  switch (verb) {
    case "list": {
      await runList();
      return;
    }
    case "ensure": {
      await runEnsure(await loadConfig(), rest);
      return;
    }
    case "regenerate": {
      await runRegenerate(await loadConfig(), rest);
      return;
    }
    case "auth": {
      await runAuth(await loadConfig(), rest);
      return;
    }
    case "rm": {
      await runRemove(await loadConfig(), rest);
      return;
    }
    default: {
      throw new Error(`Unknown sandbox sub-verb: ${verb}\n${USAGE}`);
    }
  }
}
