import {
  addTokenUsage,
  emptyTokenUsage,
  parseTokenUsage,
  sumTranscriptUsage,
  type TokenUsage,
  transcriptPathFromHookPayload,
} from "./tokenUsage.ts";

function assistantLine(input: {
  id?: string;
  inputTokens?: number;
  cacheCreation?: number;
  cacheRead?: number;
  outputTokens?: number;
}): string {
  const usage = {
    input_tokens: input.inputTokens ?? 0,
    cache_creation_input_tokens: input.cacheCreation ?? 0,
    cache_read_input_tokens: input.cacheRead ?? 0,
    output_tokens: input.outputTokens ?? 0,
  };

  return JSON.stringify({
    type: "assistant",
    message: { ...(input.id === undefined ? {} : { id: input.id }), role: "assistant", usage },
  });
}

describe(transcriptPathFromHookPayload, () => {
  it("reads the path Claude puts on stdin", () => {
    const payload = JSON.stringify({
      session_id: "abc",
      transcript_path: "/tmp/session.jsonl",
      hook_event_name: "SessionEnd",
    });

    expect(transcriptPathFromHookPayload(payload)).toBe("/tmp/session.jsonl");
  });

  it.each([
    ["not json at all", "not json at all"],
    ["an empty string", ""],
    ["a payload without the key", JSON.stringify({ session_id: "abc" })],
    ["an empty path", JSON.stringify({ transcript_path: "" })],
    ["a non-string path", JSON.stringify({ transcript_path: 42 })],
    ["a JSON array", JSON.stringify([1, 2, 3])],
  ])("returns undefined for %s rather than throwing", (_label, payload) => {
    expect(transcriptPathFromHookPayload(payload)).toBeUndefined();
  });
});

describe(sumTranscriptUsage, () => {
  it("sums the four fields across messages", () => {
    const transcript = [
      assistantLine({
        id: "m1",
        inputTokens: 10,
        cacheCreation: 20,
        cacheRead: 30,
        outputTokens: 5,
      }),
      assistantLine({ id: "m2", inputTokens: 1, cacheCreation: 2, cacheRead: 3, outputTokens: 4 }),
    ].join("\n");

    expect(sumTranscriptUsage(transcript)).toStrictEqual({
      inputTokens: 11,
      cacheCreationInputTokens: 22,
      cacheReadInputTokens: 33,
      outputTokens: 9,
      messages: 2,
    } satisfies TokenUsage);
  });

  it("counts a repeated message id once", () => {
    // A transcript rewrites the same assistant message as it streams and again
    // on resume. Summing every record inflated a real transcript 2.13x.
    const line = assistantLine({ id: "m1", inputTokens: 100, outputTokens: 50 });
    const transcript = [line, line, line].join("\n");

    const actual = sumTranscriptUsage(transcript);

    expect(actual.inputTokens).toBe(100);
    expect(actual.outputTokens).toBe(50);
    expect(actual.messages).toBe(1);
  });

  it("takes the highest value when a repeated record grows", () => {
    // Some agent versions rewrite a streaming message with cumulative counts
    // rather than repeating it verbatim. Keeping the first record would report
    // 2 output tokens for a message that finished at 19.
    const transcript = [
      JSON.stringify({ message: { id: "m1", usage: { output_tokens: 2 } } }),
      JSON.stringify({ message: { id: "m1", usage: { output_tokens: 7 } } }),
      JSON.stringify({ message: { id: "m1", usage: { output_tokens: 19 } } }),
    ].join("\n");

    const actual = sumTranscriptUsage(transcript);

    expect(actual.outputTokens).toBe(19);
    expect(actual.messages).toBe(1);
  });

  it("takes the highest value even when the last record is smaller", () => {
    // A trailing partial record must not undo a complete one, which is why
    // this is a maximum rather than last-wins.
    const transcript = [
      JSON.stringify({ message: { id: "m1", usage: { output_tokens: 19 } } }),
      JSON.stringify({ message: { id: "m1", usage: { output_tokens: 2 } } }),
    ].join("\n");

    expect(sumTranscriptUsage(transcript).outputTokens).toBe(19);
  });

  it("compares each field independently across repeats", () => {
    const transcript = [
      JSON.stringify({ message: { id: "m1", usage: { input_tokens: 9, output_tokens: 1 } } }),
      JSON.stringify({ message: { id: "m1", usage: { input_tokens: 1, output_tokens: 8 } } }),
    ].join("\n");

    const actual = sumTranscriptUsage(transcript);

    expect(actual.inputTokens).toBe(9);
    expect(actual.outputTokens).toBe(8);
  });

  it("keeps counting after a malformed line", () => {
    // Transcripts are appended to while the agent runs, so a half-written final
    // line is expected rather than exceptional.
    const transcript = [
      assistantLine({ id: "m1", outputTokens: 7 }),
      '{"type":"assistant","message":{"id":"m2","usage":{"output_to',
      assistantLine({ id: "m3", outputTokens: 3 }),
    ].join("\n");

    expect(sumTranscriptUsage(transcript).outputTokens).toBe(10);
  });

  it("counts records that carry usage but no id", () => {
    // Dropping them would undercount, and without an id there is nothing to
    // double count against.
    const transcript = [
      assistantLine({ outputTokens: 4 }),
      assistantLine({ outputTokens: 6 }),
    ].join("\n");

    const actual = sumTranscriptUsage(transcript);

    expect(actual.outputTokens).toBe(10);
    expect(actual.messages).toBe(2);
  });

  it("ignores lines that are valid JSON but not objects", () => {
    const transcript = [
      "42",
      '"a string"',
      "[1,2,3]",
      "null",
      assistantLine({ id: "m1", outputTokens: 8 }),
    ].join("\n");

    const actual = sumTranscriptUsage(transcript);

    expect(actual.outputTokens).toBe(8);
    expect(actual.messages).toBe(1);
  });

  it("ignores lines that carry no usage", () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "summary", summary: "a compaction entry" }),
      assistantLine({ id: "m1", outputTokens: 2 }),
    ].join("\n");

    expect(sumTranscriptUsage(transcript).messages).toBe(1);
  });

  it("treats missing and null fields as zero without dropping the message", () => {
    const transcript = JSON.stringify({
      type: "assistant",
      message: { id: "m1", usage: { output_tokens: 9, cache_read_input_tokens: null } },
    });

    expect(sumTranscriptUsage(transcript)).toStrictEqual({
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 9,
      messages: 1,
    } satisfies TokenUsage);
  });

  it("never collapses cache reads into fresh input", () => {
    // Cache reads bill at roughly a tenth of fresh input. A single total would
    // price a cache-heavy session as though none of it were cached.
    const transcript = assistantLine({ id: "m1", inputTokens: 1, cacheRead: 1_000_000 });

    const actual = sumTranscriptUsage(transcript);

    expect(actual.inputTokens).toBe(1);
    expect(actual.cacheReadInputTokens).toBe(1_000_000);
  });

  it.each([
    ["an empty transcript", ""],
    ["only blank lines", "\n\n   \n"],
    ["only malformed lines", "{{{\nnot json\n"],
  ])("returns an empty total for %s", (_label, transcript) => {
    expect(sumTranscriptUsage(transcript)).toStrictEqual(emptyTokenUsage());
  });
});

describe(addTokenUsage, () => {
  it("folds a resumed session into the counts already recorded", () => {
    const first = sumTranscriptUsage(assistantLine({ id: "m1", inputTokens: 5, outputTokens: 1 }));
    const second = sumTranscriptUsage(assistantLine({ id: "m2", inputTokens: 3, outputTokens: 2 }));

    expect(addTokenUsage(first, second)).toStrictEqual({
      inputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 3,
      messages: 2,
    } satisfies TokenUsage);
  });

  it("leaves a total unchanged when folding in an empty one", () => {
    const usage = sumTranscriptUsage(assistantLine({ id: "m1", outputTokens: 4 }));

    expect(addTokenUsage(usage, emptyTokenUsage())).toStrictEqual(usage);
  });
});

describe(parseTokenUsage, () => {
  it("reads a persisted total back", () => {
    const usage: TokenUsage = {
      inputTokens: 1,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
      outputTokens: 4,
      messages: 5,
    };

    expect(parseTokenUsage(JSON.parse(JSON.stringify(usage)))).toStrictEqual(usage);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "usage"],
    ["an array", [1, 2, 3]],
  ])("returns undefined for %s, so absent stays distinguishable from zero", (_label, value) => {
    expect(parseTokenUsage(value)).toBeUndefined();
  });

  it("zeroes fields that are missing or the wrong type rather than rejecting the record", () => {
    // A record that fails to parse would lose every count; a field that fails to
    // parse should lose only itself.
    expect(parseTokenUsage({ outputTokens: 7, inputTokens: "many", messages: null })).toStrictEqual(
      {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 7,
        messages: 0,
      } satisfies TokenUsage,
    );
  });

  it("round-trips whatever sumTranscriptUsage produced", () => {
    const summed = sumTranscriptUsage(assistantLine({ id: "m1", inputTokens: 9, outputTokens: 2 }));

    expect(parseTokenUsage(JSON.parse(JSON.stringify(summed)))).toStrictEqual(summed);
  });
});
