/**
 * Derive the sbx sandbox name groundcrew expects for a given sbx agent.
 * Groundcrew only addresses this existing sandbox at launch time; it does
 * not probe, create, mutate, or remove it.
 */
export function sandboxNameFor(arguments_: { agent: string }): string {
  const raw = `groundcrew-${arguments_.agent}`.toLowerCase();
  return raw
    .replaceAll(/[^a-z0-9.+-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
}
