import { readFileSync } from "node:fs";
import * as http from "node:http";
import path from "node:path";

import { createClearanceServer, resolveAllowlist } from "@clipboard-health/clearance";

import {
  clearanceAllowHostsFilesFromEnvironment,
  clearanceAllowHostsFilesValue,
} from "./clearanceAllowlist.ts";

function bundledClearanceAllowHostsFile(): string {
  return path.resolve(import.meta.dirname, "..", "..", "clearance-allow-hosts");
}

describe("bundled Clearance allowlist", () => {
  it("allows Pi startup and subscription authentication hosts", () => {
    const actual = readFileSync(bundledClearanceAllowHostsFile(), "utf8").split("\n");

    expect(actual).toEqual(
      expect.arrayContaining(["auth.openai.com", "claude.ai", "console.anthropic.com", "pi.dev"]),
    );
  });

  it("allows only the exact production Metabase hostname", () => {
    const allowHostsFile = bundledClearanceAllowHostsFile();

    const actual = resolveAllowlist({
      env: { CLEARANCE_ALLOW_HOSTS_FILES: allowHostsFile },
    });

    expect(actual).toContain("metabase.cbh.rocks");
    expect(actual).not.toContain("*.cbh.rocks");
    expect(actual).not.toContain("*.metabase.com");
  });

  it("proxies authenticated Metabase query and content-management operations", async () => {
    const { requests, server: metabaseServer } = createAuthenticatedMetabaseMock();
    const metabasePort = await listenOnLoopback({ server: metabaseServer });
    const allowedHosts = resolveAllowlist({
      env: { CLEARANCE_ALLOW_HOSTS_FILES: bundledClearanceAllowHostsFile() },
    });
    const clearanceServer = createClearanceServer({
      allowedHosts,
      allowedPorts: [metabasePort],
      dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
      shouldBlockPrivateIps: false,
    });
    const clearancePort = await listenOnLoopback({ server: clearanceServer });
    const operations = [
      { method: "POST", path: "/api/dataset" },
      { method: "GET", path: "/api/card" },
      { method: "GET", path: "/api/dashboard" },
      { method: "POST", path: "/api/card" },
      { method: "PUT", path: "/api/card/42" },
      { method: "POST", path: "/api/dashboard" },
      { method: "PUT", path: "/api/dashboard/42" },
    ] as const;

    try {
      const statuses = await Promise.all(
        operations.map(async (operation) => {
          return await requestThroughClearance({
            clearancePort,
            hostname: "metabase.cbh.rocks",
            metabasePort,
            method: operation.method,
            path: operation.path,
          });
        }),
      );

      expect(statuses).toStrictEqual(operations.map(() => 200));
      expect(requests.toSorted()).toStrictEqual(
        operations.map(({ method, path }) => `${method} ${path}`).toSorted(),
      );
      await expect(
        requestThroughClearance({
          clearancePort,
          hostname: "other.cbh.rocks",
          metabasePort,
          method: "GET",
          path: "/api/card",
        }),
      ).resolves.toBe(403);
    } finally {
      await Promise.all([
        closeServer({ server: clearanceServer }),
        closeServer({ server: metabaseServer }),
      ]);
    }
  });
});

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

async function listenOnLoopback(input: { server: http.Server }): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    input.server.once("error", reject);
    input.server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = input.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected an IP listener address");
  }
  return address.port;
}

async function requestThroughClearance(input: {
  clearancePort: number;
  hostname: string;
  metabasePort: number;
  method: string;
  path: string;
}): Promise<number | undefined> {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: input.clearancePort,
        method: input.method,
        path: `http://${input.hostname}:${input.metabasePort}${input.path}`,
        headers: { "x-api-key": "test-only-api-key" },
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode);
        });
      },
    );
    request.once("error", reject);
    request.end(input.method === "GET" ? undefined : "{}");
  });
}

async function closeServer(input: { server: http.Server }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    input.server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function createAuthenticatedMetabaseMock(): { requests: string[]; server: http.Server } {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.headers["x-api-key"] !== "test-only-api-key") {
      response.writeHead(401).end();
      return;
    }
    requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  return { requests, server };
}
