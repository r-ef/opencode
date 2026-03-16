function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

export namespace Flag {
  export const SELENE_AUTO_SHARE = truthy("SELENE_AUTO_SHARE")
  export const SELENE_GIT_BASH_PATH = process.env["SELENE_GIT_BASH_PATH"]
  export const SELENE_CONFIG = process.env["SELENE_CONFIG"]
  export declare const SELENE_TUI_CONFIG: string | undefined
  export declare const SELENE_CONFIG_DIR: string | undefined
  export const SELENE_CONFIG_CONTENT = process.env["SELENE_CONFIG_CONTENT"]
  export const SELENE_DISABLE_AUTOUPDATE = truthy("SELENE_DISABLE_AUTOUPDATE")
  export const SELENE_DISABLE_PRUNE = truthy("SELENE_DISABLE_PRUNE")
  export const SELENE_DISABLE_TERMINAL_TITLE = truthy("SELENE_DISABLE_TERMINAL_TITLE")
  export const SELENE_PERMISSION = process.env["SELENE_PERMISSION"]
  export const SELENE_DISABLE_DEFAULT_PLUGINS = truthy("SELENE_DISABLE_DEFAULT_PLUGINS")
  export const SELENE_DISABLE_LSP_DOWNLOAD = truthy("SELENE_DISABLE_LSP_DOWNLOAD")
  export const SELENE_ENABLE_EXPERIMENTAL_MODELS = truthy("SELENE_ENABLE_EXPERIMENTAL_MODELS")
  export const SELENE_DISABLE_AUTOCOMPACT = truthy("SELENE_DISABLE_AUTOCOMPACT")
  export const SELENE_DISABLE_MODELS_FETCH = truthy("SELENE_DISABLE_MODELS_FETCH")
  export const SELENE_DISABLE_CLAUDE_CODE = truthy("SELENE_DISABLE_CLAUDE_CODE")
  export const SELENE_DISABLE_CLAUDE_CODE_PROMPT =
    SELENE_DISABLE_CLAUDE_CODE || truthy("SELENE_DISABLE_CLAUDE_CODE_PROMPT")
  export const SELENE_DISABLE_CLAUDE_CODE_SKILLS =
    SELENE_DISABLE_CLAUDE_CODE || truthy("SELENE_DISABLE_CLAUDE_CODE_SKILLS")
  export const SELENE_DISABLE_EXTERNAL_SKILLS =
    SELENE_DISABLE_CLAUDE_CODE_SKILLS || truthy("SELENE_DISABLE_EXTERNAL_SKILLS")
  export declare const SELENE_DISABLE_PROJECT_CONFIG: boolean
  export const SELENE_FAKE_VCS = process.env["SELENE_FAKE_VCS"]
  export declare const SELENE_CLIENT: string
  export const SELENE_SERVER_PASSWORD = process.env["SELENE_SERVER_PASSWORD"]
  export const SELENE_SERVER_USERNAME = process.env["SELENE_SERVER_USERNAME"]
  export const SELENE_ENABLE_QUESTION_TOOL = truthy("SELENE_ENABLE_QUESTION_TOOL")

  // Experimental
  export const SELENE_EXPERIMENTAL = truthy("SELENE_EXPERIMENTAL")
  export const SELENE_EXPERIMENTAL_FILEWATCHER = truthy("SELENE_EXPERIMENTAL_FILEWATCHER")
  export const SELENE_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("SELENE_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const SELENE_EXPERIMENTAL_ICON_DISCOVERY =
    SELENE_EXPERIMENTAL || truthy("SELENE_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["SELENE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const SELENE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("SELENE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const SELENE_ENABLE_EXA =
    truthy("SELENE_ENABLE_EXA") || SELENE_EXPERIMENTAL || truthy("SELENE_EXPERIMENTAL_EXA")
  export const SELENE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("SELENE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const SELENE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("SELENE_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const SELENE_EXPERIMENTAL_OXFMT = SELENE_EXPERIMENTAL || truthy("SELENE_EXPERIMENTAL_OXFMT")
  export const SELENE_EXPERIMENTAL_LSP_TY = truthy("SELENE_EXPERIMENTAL_LSP_TY")
  export const SELENE_EXPERIMENTAL_LSP_TOOL = SELENE_EXPERIMENTAL || truthy("SELENE_EXPERIMENTAL_LSP_TOOL")
  export const SELENE_DISABLE_FILETIME_CHECK = truthy("SELENE_DISABLE_FILETIME_CHECK")
  export const SELENE_EXPERIMENTAL_PLAN_MODE = SELENE_EXPERIMENTAL || truthy("SELENE_EXPERIMENTAL_PLAN_MODE")
  export const SELENE_EXPERIMENTAL_MARKDOWN = !falsy("SELENE_EXPERIMENTAL_MARKDOWN")
  export const SELENE_MODELS_URL = process.env["SELENE_MODELS_URL"]
  export const SELENE_MODELS_PATH = process.env["SELENE_MODELS_PATH"]

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for SELENE_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "SELENE_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("SELENE_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for SELENE_TUI_CONFIG
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "SELENE_TUI_CONFIG", {
  get() {
    return process.env["SELENE_TUI_CONFIG"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for SELENE_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "SELENE_CONFIG_DIR", {
  get() {
    return process.env["SELENE_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for SELENE_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "SELENE_CLIENT", {
  get() {
    return process.env["SELENE_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
