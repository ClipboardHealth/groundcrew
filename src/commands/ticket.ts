function ticketUsage(): string {
  return "Usage: crew ticket <verb> [<args>...]\n\nVerbs:\n  doctor <ticket>  Diagnose why a ticket would or wouldn't be dispatched";
}

export async function ticketCli(argv: string[]): Promise<void> {
  const [verb] = argv;
  if (verb === undefined) {
    throw new Error(ticketUsage());
  }
  switch (verb) {
    default: {
      throw new Error(`crew ticket: unknown verb: ${verb}\n\n${ticketUsage()}`);
    }
  }
}
