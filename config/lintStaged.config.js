/**
 * @param {string[]} files
 * @returns {string[]}
 */
const filterFiles = (files) => files.filter((file) => !file.includes("/.agents/"));

/**
 * @param {string} command
 * @param {string[]} files
 * @returns {string[]}
 */
const commandForFiles = (command, files) => {
  const filteredFiles = filterFiles(files);

  return filteredFiles.length === 0 ? [] : [`${command} ${filteredFiles.join(" ")}`];
};

/**
 * @param {string[]} files
 * @returns {string[]}
 */
const formatFiles = (files) =>
  commandForFiles("oxfmt --config config/oxfmt.json --no-error-on-unmatched-pattern", files);

export default {
  "**/*.{css,scss,graphql,js,json,jsx,ts,tsx,md,mdx,toml,yml,yaml}": formatFiles,
  "**/*.{ts,tsx,js,jsx}": () => [`node --run lint`],
  "**/package.json": () => ["syncpack lint --config config/syncpack.config.ts"],
};
