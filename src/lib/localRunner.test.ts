import type { HostCapabilities } from "./host.ts";
import { assertLocalRunnerRequirements, resolveLocalRunner } from "./localRunner.ts";
import * as util from "./util.ts";

vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, log: vi.fn<typeof actual.log>() };
});

function host(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    hasSafehouse: true,
    hasSbx: false,
    hasCmux: true,
    hasTmux: false,
    hasBubblewrap: false,
    hasSocat: false,
    hasRipgrep: false,
    isMacOS: true,
    isLinux: false,
    isSafehouseSupported: true,
    isSrtSupported: true,
    isSdxSupported: true,
    ...overrides,
  };
}

describe(resolveLocalRunner, () => {
  it("auto picks safehouse on macOS", () => {
    expect(resolveLocalRunner("auto", host())).toBe("safehouse");
  });

  it("auto picks sdx on Linux", () => {
    expect(
      resolveLocalRunner(
        "auto",
        host({ isMacOS: false, isLinux: true, isSafehouseSupported: false }),
      ),
    ).toBe("sdx");
  });

  it("passes through explicit values without consulting host", () => {
    expect(resolveLocalRunner("safehouse", host())).toBe("safehouse");
    expect(resolveLocalRunner("srt", host())).toBe("srt");
    expect(resolveLocalRunner("sdx", host())).toBe("sdx");
    expect(resolveLocalRunner("none", host())).toBe("none");
  });

  it("never picks srt from auto — srt is opt-in only", () => {
    expect(resolveLocalRunner("auto", host())).not.toBe("srt");
    expect(
      resolveLocalRunner(
        "auto",
        host({ isMacOS: false, isLinux: true, isSafehouseSupported: false }),
      ),
    ).not.toBe("srt");
  });
});

describe(assertLocalRunnerRequirements, () => {
  const logMock = vi.mocked(util.log);

  beforeEach(() => {
    logMock.mockReset();
  });

  it("returns silently when safehouse is supported and on PATH", () => {
    expect(() => {
      assertLocalRunnerRequirements(host(), "safehouse");
    }).not.toThrow();
    expect(logMock).not.toHaveBeenCalled();
  });

  it("throws when safehouse is requested off macOS", () => {
    expect(() => {
      assertLocalRunnerRequirements(
        host({ isMacOS: false, isLinux: true, isSafehouseSupported: false }),
        "safehouse",
      );
    }).toThrow(/safehouse runner require macOS/);
  });

  it("throws when safehouse is requested on macOS but the binary is missing", () => {
    expect(() => {
      assertLocalRunnerRequirements(host({ hasSafehouse: false }), "safehouse");
    }).toThrow(/require `safehouse` on PATH/);
  });

  it("returns silently when sdx is supported and sbx is on PATH", () => {
    expect(() => {
      assertLocalRunnerRequirements(host({ hasSbx: true }), "sdx");
    }).not.toThrow();
    expect(logMock).not.toHaveBeenCalled();
  });

  it("throws when sdx is requested but sbx is missing", () => {
    expect(() => {
      assertLocalRunnerRequirements(host(), "sdx");
    }).toThrow(/sdx runner require `sbx`/);
  });

  it("throws when sdx is requested on an unsupported platform", () => {
    expect(() => {
      assertLocalRunnerRequirements(
        host({ isMacOS: false, isLinux: false, isSdxSupported: false, hasSbx: true }),
        "sdx",
      );
    }).toThrow(/sdx runner require macOS or Linux/);
  });

  it("returns silently when srt is requested on macOS (no Linux deps needed)", () => {
    expect(() => {
      assertLocalRunnerRequirements(host(), "srt");
    }).not.toThrow();
    expect(logMock).not.toHaveBeenCalled();
  });

  it("returns silently when srt is requested on Linux with all deps present", () => {
    expect(() => {
      assertLocalRunnerRequirements(
        host({
          isMacOS: false,
          isLinux: true,
          isSafehouseSupported: false,
          hasBubblewrap: true,
          hasSocat: true,
          hasRipgrep: true,
        }),
        "srt",
      );
    }).not.toThrow();
  });

  it("throws when srt is requested on an unsupported platform", () => {
    expect(() => {
      assertLocalRunnerRequirements(
        host({ isMacOS: false, isLinux: false, isSrtSupported: false }),
        "srt",
      );
    }).toThrow(/srt runner require macOS or Linux/);
  });

  it("throws listing every missing Linux dep when srt is requested without them", () => {
    expect(() => {
      assertLocalRunnerRequirements(
        host({
          isMacOS: false,
          isLinux: true,
          isSafehouseSupported: false,
          hasBubblewrap: false,
          hasSocat: false,
          hasRipgrep: false,
        }),
        "srt",
      );
    }).toThrow(/bubblewrap, socat, ripgrep \(rg\)/);
  });

  it("logs a warning when local.runner is 'none' instead of throwing", () => {
    expect(() => {
      assertLocalRunnerRequirements(host(), "none");
    }).not.toThrow();
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(logMock.mock.calls[0]?.[0]).toMatch(/local\.runner='none'/);
  });
});
