import path from "node:path";

import {
  clearanceAllowHostsFilesFromEnvironment,
  clearanceAllowHostsFilesValue,
} from "./clearanceAllowlist.ts";

function bundledClearanceAllowHostsFile(): string {
  return path.resolve(import.meta.dirname, "..", "..", "clearance-allow-hosts");
}

describe(clearanceAllowHostsFilesValue, () => {
  it("uses groundcrew's shipped allowlist when the user has no files configured", () => {
    const actual = clearanceAllowHostsFilesValue({
      defaultFile: "/opt/groundcrew/clearance-allow-hosts",
    });

    expect(actual).toBe("/opt/groundcrew/clearance-allow-hosts");
  });

  it("prepends the shipped allowlist to user-configured allowlist files", () => {
    const actual = clearanceAllowHostsFilesValue({
      defaultFile: "/opt/groundcrew/clearance-allow-hosts",
      existingFiles: `/tmp/team-hosts${path.delimiter}/tmp/personal-hosts`,
    });

    expect(actual).toBe(
      `/opt/groundcrew/clearance-allow-hosts${path.delimiter}/tmp/team-hosts${path.delimiter}/tmp/personal-hosts`,
    );
  });

  it("does not duplicate the shipped allowlist when the user already exported it", () => {
    const actual = clearanceAllowHostsFilesValue({
      defaultFile: "/opt/groundcrew/clearance-allow-hosts",
      existingFiles: `/opt/groundcrew/clearance-allow-hosts${path.delimiter}/tmp/personal-hosts`,
    });

    expect(actual).toBe(
      `/opt/groundcrew/clearance-allow-hosts${path.delimiter}/tmp/personal-hosts`,
    );
  });
});

describe(clearanceAllowHostsFilesFromEnvironment, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses only the bundled allowlist when env-provided files are unset", () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- undefined is the unset signal here
    vi.stubEnv("CLEARANCE_ALLOW_HOSTS_FILES", undefined);

    const actual = clearanceAllowHostsFilesFromEnvironment();

    expect(actual).toBe(bundledClearanceAllowHostsFile());
  });

  it("uses the bundled allowlist before env-provided files", () => {
    vi.stubEnv("CLEARANCE_ALLOW_HOSTS_FILES", "/tmp/personal-hosts");

    const actual = clearanceAllowHostsFilesFromEnvironment();

    expect(actual).toBe(`${bundledClearanceAllowHostsFile()}${path.delimiter}/tmp/personal-hosts`);
  });
});
