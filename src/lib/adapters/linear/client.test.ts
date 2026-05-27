import { LinearClient } from "@linear/sdk";

import { deleteEnvironmentVariable, setEnvironmentVariable } from "../../../testHelpers/env.ts";
import { readEnvironmentVariable } from "../../util.ts";
import { getLinearClient, resolveLinearApiKey } from "./client.ts";

describe("Linear API key resolution", () => {
  const originalGroundcrewKey = readEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
  const originalLinearKey = readEnvironmentVariable("LINEAR_API_KEY");

  beforeEach(() => {
    deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    deleteEnvironmentVariable("LINEAR_API_KEY");
  });

  afterEach(() => {
    if (originalGroundcrewKey === undefined) {
      deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", originalGroundcrewKey);
    }
    if (originalLinearKey === undefined) {
      deleteEnvironmentVariable("LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("LINEAR_API_KEY", originalLinearKey);
    }
  });

  describe(resolveLinearApiKey, () => {
    it("returns LINEAR_API_KEY as the source when only it is set", () => {
      setEnvironmentVariable("LINEAR_API_KEY", "lin_api_legacy");

      const actual = resolveLinearApiKey();

      expect(actual).toStrictEqual({ value: "lin_api_legacy", source: "LINEAR_API_KEY" });
    });

    it("returns GROUNDCREW_LINEAR_API_KEY as the source when only it is set", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "lin_api_groundcrew");

      const actual = resolveLinearApiKey();

      expect(actual).toStrictEqual({
        value: "lin_api_groundcrew",
        source: "GROUNDCREW_LINEAR_API_KEY",
      });
    });

    it("prefers GROUNDCREW_LINEAR_API_KEY when both are set", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "lin_api_groundcrew");
      setEnvironmentVariable("LINEAR_API_KEY", "lin_api_legacy");

      const actual = resolveLinearApiKey();

      expect(actual).toStrictEqual({
        value: "lin_api_groundcrew",
        source: "GROUNDCREW_LINEAR_API_KEY",
      });
    });

    it("falls back to LINEAR_API_KEY when GROUNDCREW_LINEAR_API_KEY is empty", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "");
      setEnvironmentVariable("LINEAR_API_KEY", "lin_api_legacy");

      const actual = resolveLinearApiKey();

      expect(actual).toStrictEqual({ value: "lin_api_legacy", source: "LINEAR_API_KEY" });
    });

    it("returns undefined when neither variable is set", () => {
      const actual = resolveLinearApiKey();

      expect(actual).toBeUndefined();
    });

    it("returns undefined when both variables are empty", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "");
      setEnvironmentVariable("LINEAR_API_KEY", "");

      const actual = resolveLinearApiKey();

      expect(actual).toBeUndefined();
    });
  });

  describe(getLinearClient, () => {
    it("returns a LinearClient when LINEAR_API_KEY is set", () => {
      setEnvironmentVariable("LINEAR_API_KEY", "lin_api_legacy");

      const actual = getLinearClient();

      expect(actual).toBeInstanceOf(LinearClient);
    });

    it("returns a LinearClient when GROUNDCREW_LINEAR_API_KEY is set", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "lin_api_groundcrew");

      const actual = getLinearClient();

      expect(actual).toBeInstanceOf(LinearClient);
    });

    it("throws when neither variable is set", () => {
      expect(() => getLinearClient()).toThrow(/GROUNDCREW_LINEAR_API_KEY or LINEAR_API_KEY/);
    });

    it("throws when both variables are empty", () => {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "");
      setEnvironmentVariable("LINEAR_API_KEY", "");

      expect(() => getLinearClient()).toThrow(/GROUNDCREW_LINEAR_API_KEY or LINEAR_API_KEY/);
    });
  });
});
