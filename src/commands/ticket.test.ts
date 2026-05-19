import { ticketCli } from "./ticket.ts";

describe("ticket CLI router", () => {
  it("throws a usage error when no verb is given", async () => {
    await expect(ticketCli([])).rejects.toThrow(/Usage: crew ticket <verb>/);
  });

  it("throws a friendly error for an unknown verb", async () => {
    await expect(ticketCli(["bogus"])).rejects.toThrow(/unknown verb: bogus/);
  });
});
