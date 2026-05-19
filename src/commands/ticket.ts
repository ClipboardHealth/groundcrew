import { ticketDoctorCli } from "./ticketDoctor.ts";

function ticketUsage(): string {
  return "Usage: crew ticket <verb> [<args>...]\n\nVerbs:\n  doctor <ticket>  Diagnose why a ticket would or wouldn't be dispatched";
}

export async function ticketCli(argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    throw new Error(ticketUsage());
  }
  switch (verb) {
    case "doctor": {
      await ticketDoctorCli(rest);
      /* v8 ignore next @preserve */
      break;
    }
    default: {
      throw new Error(`crew ticket: unknown verb: ${verb}\n\n${ticketUsage()}`);
    }
  }
}
