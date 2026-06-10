export default {
  semverGroups: [
    {
      dependencies: ["**"],
      dependencyTypes: ["dev", "prod", "resolutions"],
      packages: ["**"],
      range: "",
    },
  ],
  versionGroups: [
    {
      dependencies: ["@types/node"],
      isIgnored: true,
      label: "Managed manually to stay in sync with the installed Node version.",
    },
    {
      dependencyTypes: ["peer"],
      label: "Allow for flexible peer dependency versions.",
      specifierTypes: ["range", "range-complex", "range-major", "range-minor"],
    },
    {
      dependencies: ["@types/**"],
      dependencyTypes: ["!dev"],
      isBanned: true,
      label: "@types packages should only be under devDependencies.",
    },
  ],
  // oxlint-disable-next-line typescript/consistent-type-imports
} satisfies import("syncpack").RcFile;
