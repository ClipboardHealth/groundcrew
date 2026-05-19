import type { HostCapabilities } from "./host.ts";
import { assertLocalRunnerRequirements } from "./localRunner.ts";
import * as util from "./util.ts";

function host(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    hasSafehouse: false,
    hasBwrap: false,
    hasCmux: false,
    hasTmux: false,
    isMacOS: false,
    isLinux: false,
    isSafehouseSupported: false,
    ...overrides,
  };
}

describe(assertLocalRunnerRequirements, () => {
  describe("safehouse", () => {
    it("rejects non-macOS hosts with guidance toward bubblewrap or remote", () => {
      expect(() => {
        assertLocalRunnerRequirements(host({ isLinux: true }), "safehouse");
      }).toThrow(/safehouse runner require macOS/u);
    });

    it("rejects macOS hosts when safehouse is missing", () => {
      expect(() => {
        assertLocalRunnerRequirements(
          host({ isMacOS: true, isSafehouseSupported: true, hasSafehouse: false }),
          "safehouse",
        );
      }).toThrow(/`safehouse` on PATH/u);
    });

    it("passes when macOS + safehouse on PATH", () => {
      expect(() => {
        assertLocalRunnerRequirements(
          host({ isMacOS: true, isSafehouseSupported: true, hasSafehouse: true }),
          "safehouse",
        );
      }).not.toThrow();
    });
  });

  describe("bubblewrap", () => {
    it("rejects non-Linux hosts", () => {
      expect(() => {
        assertLocalRunnerRequirements(host({ isMacOS: true }), "bubblewrap");
      }).toThrow(/bubblewrap runner require Linux/u);
    });

    it("rejects Linux hosts when bwrap is missing, with install guidance", () => {
      expect(() => {
        assertLocalRunnerRequirements(host({ isLinux: true, hasBwrap: false }), "bubblewrap");
      }).toThrow(/`bwrap` \(Bubblewrap\) on PATH/u);
    });

    it("passes when Linux + bwrap on PATH", () => {
      expect(() => {
        assertLocalRunnerRequirements(host({ isLinux: true, hasBwrap: true }), "bubblewrap");
      }).not.toThrow();
    });
  });

  describe("none", () => {
    it("does not throw on Linux and logs a sandbox warning", () => {
      const spy = vi.spyOn(util, "log").mockImplementation(() => {
        // suppress test output
      });

      try {
        assertLocalRunnerRequirements(host({ isLinux: true }), "none");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0]?.[0])).toMatch(/WARNING.*without sandboxing/u);
      } finally {
        spy.mockRestore();
      }
    });

    it("does not throw on macOS and logs a sandbox warning", () => {
      const spy = vi.spyOn(util, "log").mockImplementation(() => {
        // suppress test output
      });

      try {
        assertLocalRunnerRequirements(host({ isMacOS: true }), "none");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0]?.[0])).toMatch(/WARNING.*without sandboxing/u);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
