import { ticketCli } from "./ticket.ts";

describe("ticket CLI router", () => {
  it("throws a usage error when no verb is given", async () => {
    await expect(ticketCli([])).rejects.toThrow(/Usage: crew ticket <verb>/);
  });

  it("throws a friendly error for an unknown verb", async () => {
    await expect(ticketCli(["bogus"])).rejects.toThrow(/unknown verb: bogus/);
  });

  it("dispatches the 'doctor' verb to ticketDoctorCli (arg-validation error, not unknown-verb error)", async () => {
    // Calling with no ticket arg triggers the ticketDoctorCli arg-validation error,
    // which proves the router dispatched to doctor rather than falling through to "unknown verb".
    await expect(ticketCli(["doctor"])).rejects.toThrow(/Usage: crew ticket doctor <ticket>/);
  });
});
