import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BUILD_SECRET_NAMES } from "./config.ts";
import type { AttachmentFetchResult } from "./taskSource.ts";
import { renderAttachments, stageBuildSecrets } from "./stagedLaunch.ts";

function stagedFile(
  overrides: Partial<Extract<AttachmentFetchResult["attachments"][number], { kind: "file" }>> = {},
) {
  return {
    kind: "file" as const,
    filename: "Mockup v3.png",
    relativePath: ".groundcrew/attachments/Mockup v3.png",
    title: "Mockup v3.png",
    url: "https://example.test/mockup",
    sizeBytes: 10,
    ...overrides,
  };
}

describe(renderAttachments, () => {
  it("renders an empty string for an empty result with no fetch error", () => {
    const actual = renderAttachments({ attachments: [] });

    expect(actual).toBe("");
  });

  it("renders a staged file as a backticked relative path under Attached files", () => {
    const actual = renderAttachments({ attachments: [stagedFile()] });

    expect(actual).toContain("## Attached files");
    expect(actual).toContain("- `.groundcrew/attachments/Mockup v3.png`");
    expect(actual).not.toContain("## References");
  });

  it("appends the original title when disambiguation renamed the file", () => {
    const actual = renderAttachments({
      attachments: [
        stagedFile({
          filename: "Mockup (2).png",
          relativePath: ".groundcrew/attachments/Mockup (2).png",
          title: "Mockup.png",
        }),
      ],
    });

    expect(actual).toContain(
      '- `.groundcrew/attachments/Mockup (2).png` - originally "Mockup.png"',
    );
  });

  it("renders a skipped attachment with reason, detail, and url sub-bullets", () => {
    const actual = renderAttachments({
      attachments: [
        {
          kind: "skipped",
          title: "huge-dataset.zip",
          url: "https://example.test/huge",
          reason: "exceeds-per-file-cap",
          detail: "89 MiB exceeds 25 MiB cap",
        },
      ],
    });

    expect(actual).toContain('- "huge-dataset.zip" - not staged');
    expect(actual).toContain("  - reason: exceeds-per-file-cap - 89 MiB exceeds 25 MiB cap");
    expect(actual).toContain("  - url: https://example.test/huge");
  });

  it("omits the url sub-bullet when the skipped attachment has no url", () => {
    const actual = renderAttachments({
      attachments: [
        {
          kind: "skipped",
          title: "phantom.bin",
          reason: "download-failed",
          detail: "reported by source but not found in stage dir",
        },
      ],
    });

    expect(actual).toContain('- "phantom.bin" - not staged');
    expect(actual).not.toContain("- url:");
  });

  it("renders reference links under a References section after Attached files", () => {
    const actual = renderAttachments({
      attachments: [
        stagedFile(),
        {
          kind: "link",
          title: "Related PR",
          url: "https://github.com/acme/widgets/pull/42",
          sourceType: "github",
        },
      ],
    });

    expect(actual).toContain('- "Related PR" - https://github.com/acme/widgets/pull/42');
    expect(actual.indexOf("## Attached files")).toBeLessThan(actual.indexOf("## References"));
  });

  it("omits the Attached files section when only links are present", () => {
    const actual = renderAttachments({
      attachments: [{ kind: "link", title: "Spec", url: "https://example.test/spec" }],
    });

    expect(actual).toContain("## References");
    expect(actual).not.toContain("## Attached files");
  });

  it("renders a fetch-failure notice when the whole fetch failed", () => {
    const actual = renderAttachments({ attachments: [], fetchError: "GraphQL down" });

    expect(actual).toBe(
      "*Attachment fetch failed: GraphQL down. The task may have attachments that are not available here.*",
    );
  });
});

describe(stageBuildSecrets, () => {
  let promptDir: string;

  beforeEach(() => {
    promptDir = mkdtempSync(path.join(os.tmpdir(), "groundcrew-test-"));
    for (const name of BUILD_SECRET_NAMES) {
      vi.stubEnv(name, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(promptDir, { recursive: true, force: true });
  });

  it("returns undefined when no build secrets are set", () => {
    expect(stageBuildSecrets(promptDir)).toBeUndefined();
  });

  it("writes a secrets file and returns its path when secrets are present", () => {
    vi.stubEnv("NPM_TOKEN", "my-npm-token");

    const result = stageBuildSecrets(promptDir);
    const expected = path.join(promptDir, "secrets.env");

    expect(result).toBe(expected);
    expect(readFileSync(expected, "utf8")).toContain("NPM_TOKEN='my-npm-token'");
  });
});
