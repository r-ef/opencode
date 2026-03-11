import path from "path"
import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "url"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionAmbient } from "../../src/session/ambient"
import { SessionCoordinator } from "../../src/session/coordinator"
import { SessionPrompt } from "../../src/session/prompt"
import { TaskBranch } from "../../src/task/branch"
import { TaskRun } from "../../src/task/run"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

async function lastText(sessionID: string) {
  const msg = await Session.messages({ sessionID }).then((rows) => rows.findLast((item) => item.info.role === "user"))
  if (!msg || msg.info.role !== "user") return ""
  return msg.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
}

async function waitForText(sessionID: string, pattern: string) {
  for (let i = 0; i < 40; i++) {
    const text = await lastText(sessionID)
    if (text.includes(pattern)) return text
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${pattern}`)
}

async function lastAssistantText(sessionID: string) {
  const msg = await Session.messages({ sessionID }).then((rows) => rows.findLast((item) => item.info.role === "assistant"))
  if (!msg || msg.info.role !== "assistant") return ""
  return msg.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
}

describe("session.prompt missing file", () => {
  test("injects shared context updates from sibling sessions", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const left = await Session.branch({ sessionID: root.id })
        const right = await Session.branch({ sessionID: root.id })

        await Session.contextWrite({
          session_id: left.id,
          kind: "task_result",
          title: "left done",
          body: "Left branch finished with passing tests.",
        })

        const msg = await SessionPrompt.prompt({
          sessionID: right.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "continue" }],
        })
        if (msg.info.role !== "user") throw new Error("expected user message")

        const text = msg.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        expect(text).toContain("Shared session context updates:")
        expect(text).toContain("Left branch finished with passing tests.")
        expect(text).toContain("get at least one independent verification pass before finalizing")
      },
    })
  })

  test("only injects shared context deltas", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const left = await Session.branch({ sessionID: root.id })
        const right = await Session.branch({ sessionID: root.id })

        await Session.contextWrite({
          session_id: left.id,
          kind: "task_result",
          title: "left done",
          body: "first update",
        })

        const a = await SessionPrompt.prompt({
          sessionID: right.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "continue" }],
        })
        if (a.info.role !== "user") throw new Error("expected user message")
        const atext = a.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        expect(atext).toContain("first update")

        const b = await SessionPrompt.prompt({
          sessionID: right.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "continue again" }],
        })
        if (b.info.role !== "user") throw new Error("expected user message")
        const btext = b.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        expect(btext).not.toContain("Shared session context updates:")

        await Session.contextWrite({
          session_id: left.id,
          kind: "task_result",
          title: "left done",
          body: "second update",
        })

        const c = await SessionPrompt.prompt({
          sessionID: right.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "continue third" }],
        })
        if (c.info.role !== "user") throw new Error("expected user message")
        const ctext = c.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        expect(ctext).toContain("second update")
      },
    })
  })

  test("followup injects shared context updates for background reminders", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const child = await Session.create({ parentID: root.id, title: "child" })

        await SessionPrompt.prompt({
          sessionID: root.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start background work" }],
        })

        await Session.contextWrite({
          session_id: child.id,
          kind: "task_result",
          title: "child done",
          body: "Child task finished successfully.",
        })

        const msg = await SessionPrompt.followup({
          sessionID: root.id,
          text: "<system-reminder>\nBackground work finished.\n</system-reminder>",
          run: false,
        })
        if (msg.info.role !== "user") throw new Error("expected user message")

        const text = msg.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        expect(text).toContain("Shared session context updates:")
        expect(text).toContain("Child task finished successfully.")
        expect(text).toContain("Background work finished.")
      },
    })
  })

  test("injects actionable coordination updates from sibling sessions", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const left = await Session.branch({ sessionID: root.id })
        const right = await Session.branch({ sessionID: root.id })

        await Session.coordinationWrite({
          session_id: left.id,
          target_session_id: right.id,
          kind: "request",
          status: "open",
          title: "Check parser",
          body: "Confirm whether parser fallback is reachable.",
          request_id: "req_parser",
        })

        const text = await waitForText(right.id, "Agent collaboration updates:")
        expect(text).toContain("Agent collaboration updates:")
        expect(text).toContain("Confirm whether parser fallback is reachable.")
        expect(text).toContain("Respond to material requests and conflicts before finalizing.")
      },
    })
  })

  test("ambient tracker follows background task milestones without task_watch polling", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const task = await Session.create({ parentID: root.id, title: "task" })

        SessionAmbient.track({
          kind: "task",
          id: task.id,
          parentID: root.id,
          rootID: root.id,
          title: "inspect parser",
        })

        await TaskRun.upsert({
          session: task,
          parent: root,
          description: "inspect parser",
          prompt: "inspect parser",
          agent: "build",
          background: true,
          model: { providerID: "openai", modelID: "gpt-5.2" },
        })

        await Session.contextWrite({
          session_id: task.id,
          kind: "task_result",
          title: "partial",
          body: "Parser findings available.",
          metadata: {
            task_id: task.id,
          },
        })

        const mid = await waitForText(root.id, "Background task published a useful update")
        expect(mid).toContain("inspect parser")
        expect(mid).not.toContain("No new updates yet.")

        await TaskRun.finish(task.id, {
          status: "completed",
          output: "done",
        })

        const final = await waitForText(root.id, "Background task complete")
        expect(final).toContain("inspect parser")
        expect(final).not.toContain("task_watch")
      },
    })
  })

  test("ambient tracker surfaces branch winner milestones once", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const left = await Session.create({ parentID: root.id, title: "left" })
        const right = await Session.create({ parentID: root.id, title: "right" })

        const run = await TaskBranch.create({
          id: "tool_branch_test",
          sessionId: root.id,
          rootSessionId: root.id,
          projectID: root.projectID,
          directory: root.directory,
          messageId: "msg_branch_test",
          description: "branch parser",
          prompt: "branch parser",
          subagent: "build",
          background: true,
          created: Date.now(),
          status: "running",
          base: {
            dir: root.directory,
            root: root.directory,
          },
          model: {
            providerID: "openai",
            modelID: "gpt-5.2",
          },
          branches: [
            { name: "left", prompt: "left", sessionId: left.id, status: "completed" },
            { name: "right", prompt: "right", sessionId: right.id, status: "completed" },
          ],
          winner: null,
          applied: null,
        })

        SessionAmbient.track({
          kind: "branch",
          id: run.id,
          parentID: root.id,
          rootID: root.id,
          title: run.description,
        })

        await TaskBranch.markWinner(run.id, {
          name: "left",
          sessionId: left.id,
          score: 92,
          confidence: 0.9,
          reason: "best",
        })

        const text = await waitForText(root.id, "Background branch winner ready")
        expect(text).toContain("branch parser")
        expect(text).toContain("task_branch_apply")
      },
    })
  })

  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "does-not-exist.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "still-missing.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        await Session.remove(session.id)
      },
    })
  })

  test("loop emits coordinator-owned synthesis once the plan is ready", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })
    await Bun.write(path.join(tmp.path, "demo.ts"), "export const demo = 1\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionPrompt.prompt({
          sessionID: root.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "analyze this codebase" }],
        })

        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "analyze this codebase",
        })
        const first = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        for (const [idx, item] of first.tasks.entries()) {
          const child = await Session.create({ parentID: root.id, title: `child-${idx}` })
          await SessionCoordinator.bind({
            parent_session_id: root.id,
            session_id: child.id,
            agent: item.agent,
            description: item.description,
            prompt: item.prompt,
          })
          await SessionCoordinator.complete({
            session_id: child.id,
            text: [
              `Primary ${idx}`,
              "",
              "<analysis_json>",
              JSON.stringify({
                summary: `Primary ${idx}`,
                claims: [
                  {
                    topic: `topic-${idx}`,
                    statement: `statement-${idx}`,
                    evidence: [path.join(tmp.path, "demo.ts:1")],
                    confidence: "high",
                    verdict: "report",
                  },
                ],
                risks: [],
                verify_topics: [`topic-${idx}`],
              }),
              "</analysis_json>",
            ].join("\n"),
          })
        }

        const verify = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        const child = await Session.create({ parentID: root.id, title: "verifier" })
        await SessionCoordinator.bind({
          parent_session_id: root.id,
          session_id: child.id,
          agent: verify.tasks[0]!.agent,
          description: verify.tasks[0]!.description,
          prompt: verify.tasks[0]!.prompt,
        })
        await SessionCoordinator.complete({
          session_id: child.id,
          text: [
            "Verifier",
            "",
            "<analysis_json>",
            JSON.stringify({
              summary: "Verifier",
              claims: [
                {
                  topic: "topic-0",
                  statement: "statement-0",
                  evidence: [path.join(tmp.path, "demo.ts:1")],
                  confidence: "high",
                  verdict: "confirm",
                },
              ],
              risks: [],
              verify_topics: ["topic-0"],
            }),
            "</analysis_json>",
          ].join("\n"),
        })

        await SessionPrompt.loop({
          sessionID: root.id,
        })

        const text = await lastAssistantText(root.id)
        expect(text).toContain("Accepted findings:")
        expect(text).toContain("Coordination summary:")
        expect(text).toContain("statement-0")
      },
    })
  })

  test("loop emits one concise coordinator wait status while blocked", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionPrompt.prompt({
          sessionID: root.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "analyze this codebase" }],
        })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "analyze this codebase",
        })
        await SessionCoordinator.schedule({
          session_id: root.id,
        })

        await SessionPrompt.loop({
          sessionID: root.id,
        })
        await SessionPrompt.loop({
          sessionID: root.id,
        })

        const msgs = await Session.messages({ sessionID: root.id })
        const assistants = msgs.filter((item) => item.info.role === "assistant")
        expect(assistants).toHaveLength(1)
        const text = await lastAssistantText(root.id)
        expect(text).toContain("Coordinated analysis is still running.")
        expect(text).toContain("Waiting for the remaining workstreams")
      },
    })
  })
})

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const template = "Read @file#name.txt"
        const parts = await SessionPrompt.resolvePromptParts(template)
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          const other = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).toBeUndefined()

          const match = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.model).toEqual({ providerID: "openai", modelID: "gpt-5.2" })
          expect(match.info.variant).toBe("xhigh")

          const override = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            variant: "high",
            parts: [{ type: "text", text: "hello third" }],
          })
          if (override.info.role !== "user") throw new Error("expected user message")
          expect(override.info.variant).toBe("high")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})
