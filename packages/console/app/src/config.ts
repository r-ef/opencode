/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://selene.run",

  // GitHub
  github: {
    repoUrl: "https://github.com/anomalyco/selene",
    starsFormatted: {
      compact: "100K",
      full: "100,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/selene",
    discord: "https://discord.gg/selene",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "700",
    commits: "9,000",
    monthlyUsers: "2.5M",
  },
} as const
