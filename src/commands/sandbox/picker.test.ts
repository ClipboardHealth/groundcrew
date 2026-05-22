import checkbox from "@inquirer/checkbox";
import { pickTools, type ToolChoice } from "./picker.ts";

vi.mock("@inquirer/checkbox", () => ({
  default: vi.fn<typeof checkbox>(),
}));

const checkboxMock = vi.mocked(checkbox);

describe(pickTools, () => {
  beforeEach(() => {
    checkboxMock.mockReset();
  });

  it("annotates authenticated choices with ✓ and unauthed with ○, pre-checking the unauthed ones", async () => {
    checkboxMock.mockResolvedValue([]);
    const choices: ToolChoice[] = [
      { key: "claude", label: "Claude (claude)", authenticated: true },
      { key: "github", label: "GitHub CLI (github)", authenticated: false },
    ];

    await pickTools(choices);

    const passed = checkboxMock.mock.calls[0]?.[0];
    expect(passed?.choices).toStrictEqual([
      { name: "✓ Claude (claude)", value: "claude", checked: false },
      { name: "○ GitHub CLI (github)", value: "github", checked: true },
    ]);
  });

  it("returns the engineer's selected keys", async () => {
    checkboxMock.mockResolvedValue(["github"]);
    const choices: ToolChoice[] = [
      { key: "claude", label: "Claude (claude)", authenticated: true },
      { key: "github", label: "GitHub CLI (github)", authenticated: false },
    ];

    const result = await pickTools(choices);

    expect(result).toStrictEqual(["github"]);
  });
});
