import type { Configuration } from "electron-builder"

const channel = (() => {
  const raw = process.env.SELENE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const getBase = (): Configuration => ({
  artifactName: "selene-electron-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "resources/",
      to: "",
      filter: ["selene-cli*"],
    },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "Selene",
    schemes: ["selene"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    target: ["nsis"],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "ai.selene.desktop.dev",
        productName: "Selene Dev",
        rpm: { packageName: "selene-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.selene.desktop.beta",
        productName: "Selene Beta",
        protocols: { name: "Selene Beta", schemes: ["selene"] },
        publish: { provider: "github", owner: "anomalyco", repo: "selene-beta", channel: "latest" },
        rpm: { packageName: "selene-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.selene.desktop",
        productName: "Selene",
        protocols: { name: "Selene", schemes: ["selene"] },
        publish: { provider: "github", owner: "anomalyco", repo: "selene", channel: "latest" },
        rpm: { packageName: "selene" },
      }
    }
  }
}

export default getConfig()
