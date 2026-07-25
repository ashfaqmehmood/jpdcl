export async function analyzeCommits(_pluginConfig, { commits }) {
  return commits.some(({ message }) => !message.includes("[skip release]")) ? "patch" : null;
}
