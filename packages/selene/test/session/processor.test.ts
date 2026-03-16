import { expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"
import { MessageV2 } from "../../src/session/message-v2"

function tool(tool: string, input: unknown) {
  return {
    id: `${tool}-${JSON.stringify(input)}`,
    messageID: "msg_1",
    sessionID: "ses_1",
    type: "tool",
    callID: `${tool}-call`,
    tool,
    state: {
      status: "completed",
      input,
      output: "",
      time: {
        start: 1,
        end: 2,
      },
    },
  } as MessageV2.ToolPart
}

test("doom loop detector catches repeated search churn", () => {
  const parts = [
    tool("glob", { pattern: "src/**/*.ts" }),
    tool("grep", { pattern: "analyze" }),
    tool("read", { file: "a.ts" }),
    tool("glob", { pattern: "test/**/*.ts" }),
    tool("grep", { pattern: "review" }),
    tool("read", { file: "b.ts" }),
    tool("glob", { pattern: "lib/**/*.ts" }),
    tool("grep", { pattern: "audit" }),
  ]

  expect(
    SessionProcessor.shouldWarnDoomLoop({
      parts,
      tool: "read",
      args: { file: "c.ts" },
    }),
  ).toBe(true)
})

test("doom loop detector ignores short focused exploration", () => {
  const parts = [tool("glob", { pattern: "src/**/*.ts" }), tool("read", { file: "a.ts" })]

  expect(
    SessionProcessor.shouldWarnDoomLoop({
      parts,
      tool: "grep",
      args: { pattern: "needle" },
    }),
  ).toBe(false)
})
