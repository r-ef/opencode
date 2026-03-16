const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://selene.run" : `https://${stage}.selene.run`,
  console: stage === "production" ? "https://selene.run/auth" : `https://${stage}.selene.run/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/anomalyco/selene",
  discord: "https://selene.run/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
