import path from "node:path";

import {
  createCapAccountant,
  resolveInsideStageDir,
  sanitizeAttachmentFilename,
} from "./attachmentStaging.ts";

describe(sanitizeAttachmentFilename, () => {
  it("keeps a safe title verbatim, preserving spaces, case, and punctuation", () => {
    const input = { title: "Mockup v3 (final).PNG", fallbackId: "abc123def456" };

    const actual = sanitizeAttachmentFilename(input);

    expect(actual).toBe("Mockup v3 (final).PNG");
  });

  it("falls back to attachment-<id-prefix> for an empty title", () => {
    const input = { title: "", fallbackId: "abc123def456" };

    const actual = sanitizeAttachmentFilename(input);

    expect(actual).toBe("attachment-abc123de");
  });

  it("falls back for a title containing a forward slash", () => {
    const input = { title: "notes/../../etc/passwd", fallbackId: "abc123def456" };

    const actual = sanitizeAttachmentFilename(input);

    expect(actual).toBe("attachment-abc123de");
  });

  it("falls back for a title containing a backslash", () => {
    const input = { title: String.raw`evil\name.txt`, fallbackId: "abc123def456" };

    const actual = sanitizeAttachmentFilename(input);

    expect(actual).toBe("attachment-abc123de");
  });

  it("falls back for dot and dot-dot titles", () => {
    const dotInput = { title: ".", fallbackId: "abc123def456" };
    const dotDotInput = { title: "..", fallbackId: "abc123def456" };

    expect(sanitizeAttachmentFilename(dotInput)).toBe("attachment-abc123de");
    expect(sanitizeAttachmentFilename(dotDotInput)).toBe("attachment-abc123de");
  });

  it("falls back for a title containing a NUL byte", () => {
    const input = { title: "evil\0.txt", fallbackId: "abc123def456" };

    const actual = sanitizeAttachmentFilename(input);

    expect(actual).toBe("attachment-abc123de");
  });

  it("falls back for an over-long title", () => {
    const input = { title: "a".repeat(256), fallbackId: "abc123def456" };

    const actual = sanitizeAttachmentFilename(input);

    expect(actual).toBe("attachment-abc123de");
  });

  it("keeps a title exactly at the length limit", () => {
    const input = { title: "a".repeat(255), fallbackId: "abc123def456" };

    const actual = sanitizeAttachmentFilename(input);

    expect(actual).toBe("a".repeat(255));
  });
});

describe(resolveInsideStageDir, () => {
  const stageDir = "/work/repo-a-team-1/.groundcrew/attachments";

  it("resolves a plain filename to an absolute path inside the stage dir", () => {
    const actual = resolveInsideStageDir({ stageDir, filename: "mockup.png" });

    expect(actual).toBe(path.join(stageDir, "mockup.png"));
  });

  it("rejects a traversal filename that escapes the stage dir", () => {
    const actual = resolveInsideStageDir({ stageDir, filename: "../escape.txt" });

    expect(actual).toBeUndefined();
  });

  it("rejects an absolute filename", () => {
    const actual = resolveInsideStageDir({ stageDir, filename: "/etc/passwd" });

    expect(actual).toBeUndefined();
  });

  it("rejects a nested path (stage dir is flat)", () => {
    const actual = resolveInsideStageDir({ stageDir, filename: "nested/file.txt" });

    expect(actual).toBeUndefined();
  });

  it("rejects dot and empty filenames that resolve to the stage dir itself", () => {
    expect(resolveInsideStageDir({ stageDir, filename: "." })).toBeUndefined();
    expect(resolveInsideStageDir({ stageDir, filename: "" })).toBeUndefined();
  });
});

describe(createCapAccountant, () => {
  it("admits files within both caps and accumulates their sizes", () => {
    const accountant = createCapAccountant({ maxAttachmentBytes: 100, maxTotalBytes: 250 });

    expect(accountant.admit(100)).toEqual({ admitted: true });
    expect(accountant.admit(100)).toEqual({ admitted: true });
    expect(accountant.admit(50)).toEqual({ admitted: true });
  });

  it("rejects a single file over the per-file cap", () => {
    const accountant = createCapAccountant({ maxAttachmentBytes: 100, maxTotalBytes: 250 });

    const actual = accountant.admit(101);

    expect(actual).toEqual({ admitted: false, reason: "exceeds-per-file-cap" });
  });

  it("rejects the file that would push the running total over the total cap", () => {
    const accountant = createCapAccountant({ maxAttachmentBytes: 100, maxTotalBytes: 250 });

    accountant.admit(100);
    accountant.admit(100);

    expect(accountant.admit(51)).toEqual({ admitted: false, reason: "exceeds-per-task-cap" });
  });

  it("does not count rejected files toward the running total", () => {
    const accountant = createCapAccountant({ maxAttachmentBytes: 100, maxTotalBytes: 150 });

    accountant.admit(100);
    expect(accountant.admit(100)).toEqual({ admitted: false, reason: "exceeds-per-task-cap" });

    expect(accountant.admit(50)).toEqual({ admitted: true });
  });

  it("prefers the per-file reason when a file exceeds both caps", () => {
    const accountant = createCapAccountant({ maxAttachmentBytes: 100, maxTotalBytes: 250 });

    accountant.admit(100);
    accountant.admit(100);

    expect(accountant.admit(200)).toEqual({ admitted: false, reason: "exceeds-per-file-cap" });
  });
});
