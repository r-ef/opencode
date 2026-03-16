import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionContextBuilder } from "../../src/session/context-builder"
import { SessionMemory } from "../../src/session/memory"
import { Log } from "../../src/util/log"
import { assistant, build, compact, model, text, user, type Phase } from "../fixture/continuity"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("session continuity", () => {
  const phases: Phase[] = [
    {
      user: "Refactor src/router.ts without changing the public API. Always run bun test before stopping. Keep responses concise.",
      parts: [
        {
          type: "text",
          text: "Tried inlining the route builder in src/router.ts. That failed because it changed the exported createRouter signature. Pending: restore the signature and rerun bun test in src/router.test.ts.",
        },
        {
          type: "tool",
          tool: "bash",
          callID: "call_1",
          state: {
            status: "completed",
            input: { cmd: "bun test", path: "src/router.ts" },
            output: "2 failing tests in src/router.test.ts after the inline builder change",
            title: "bun test",
            metadata: {},
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          },
        },
      ],
      note: "Router refactor: keep the public API and rerun bun test after restoring createRouter.",
    },
    {
      user: "Also update src/routes.ts and leave src/api.ts untouched.",
      parts: [
        {
          type: "text",
          text: "Decided to leave src/api.ts unchanged. Pending: finish the cleanup in src/routes.ts. Validation: bun typecheck still fails on route aliases in src/routes.ts.",
        },
        {
          type: "tool",
          tool: "bash",
          callID: "call_2",
          state: {
            status: "completed",
            input: { cmd: "bun typecheck", path: "src/routes.ts" },
            output: "1 type error remains in src/routes.ts route alias handling",
            title: "bun typecheck",
            metadata: {},
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          },
        },
      ],
      note: "Routes cleanup: keep src/api.ts untouched and fix the remaining src/routes.ts type error.",
    },
    {
      user: "Document the invariant in src/router.md too.",
      parts: [
        {
          type: "text",
          text: "Added the invariant note for src/router.md. Do not retry the inline builder approach; it broke createRouter earlier. Pending: final bun test and bun typecheck before stopping.",
        },
        {
          type: "tool",
          tool: "bash",
          callID: "call_3",
          state: {
            status: "error",
            input: { cmd: "bun test && bun typecheck", path: "src/router.md" },
            error: "final verification not run yet",
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          },
        },
      ],
      note: "Router docs added; avoid the failed inline builder approach and finish final verification.",
    },
  ]

  test("preserves goals, files, constraints, and pending work after 1, 2, and 3 compactions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const one = await build({
          sessionID: session.id,
          phases: phases.slice(0, 1),
          query: "Finish the router work.",
        })
        expect(one).toContain("without changing the public API")
        expect(one).toContain("Always run bun test")
        expect(one).toContain("src/router.ts")
        expect(one).toContain("src/router.test.ts")

        await Session.remove(session.id)

        const session2 = await Session.create({})
        const two = await build({
          sessionID: session2.id,
          phases: phases.slice(0, 2),
          query: "Finish the router work.",
        })
        expect(two).toContain("src/routes.ts")
        expect(two).toContain("src/api.ts")
        expect(two).toContain("bun typecheck")

        await Session.remove(session2.id)

        const session3 = await Session.create({})
        const three = await build({
          sessionID: session3.id,
          phases: phases.slice(0, 3),
          query: "Finish the router work.",
        })
        expect(three).toContain("src/router.md")
        expect(three).toContain("Do not retry the inline builder approach")
        expect(three).toContain("final bun test")
      },
    })
  })

  test("retrieves failed approaches over unrelated recent chat when the active file overlaps", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const turn = await user(
          session.id,
          "Fix src/router.ts and keep the exported createRouter signature intact.",
        )
        await assistant(session.id, turn.id, [
          {
            type: "text",
            text: "The inline builder approach failed in src/router.ts because it broke createRouter. Do not repeat it.",
          },
        ])
        await SessionMemory.extract({
          sessionID: session.id,
          messageID: turn.id,
        })
        await compact(session.id, "Router note: do not retry the inline builder approach.")

        const chatter = await user(session.id, "By the way, I also like clean commit messages.")
        await assistant(session.id, chatter.id, [
          {
            type: "text",
            text: "Noted the commit message preference.",
          },
        ])
        await SessionMemory.extract({
          sessionID: session.id,
          messageID: chatter.id,
        })
        await compact(session.id, "Preference note only.")

        const current = await user(session.id, "Continue fixing src/router.ts.")
        const msgs = await MessageV2.filterCompacted(MessageV2.stream(session.id))
        const built = await SessionContextBuilder.build({
          sessionID: session.id,
          model: model(),
          user: current,
          messages: msgs,
        })
        const text = JSON.stringify(built.messages[0] ?? "")

        expect(text).toContain("src/router.ts")
        expect(text).toContain("Do not repeat it")
        expect(text).toContain("createRouter")
      },
    })
  })

  test("keeps branch/task lineage retrievable across compactions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const phase: Phase[] = [
          {
            user: "Investigate src/router.ts with a branch run and keep the best approach.",
            parts: [
              {
                type: "tool",
                tool: "task_branch",
                callID: "branch_1",
                state: {
                  status: "completed",
                  input: { prompt: "Investigate src/router.ts" },
                  output: "Winner selected for src/router.ts investigation",
                  title: "task_branch",
                  metadata: {
                    branch_id: "branch_eval_1",
                    task_id: "ses_task_1",
                    filePath: "src/router.ts",
                  },
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              },
            ],
            note: "Best branch recorded for src/router.ts under branch_eval_1 / ses_task_1.",
          },
          {
            user: "Keep going on src/router.ts and do not lose the winner selection.",
            parts: [
              {
                type: "text",
                text: "Pending: apply the winner from branch_eval_1 after validation on src/router.ts.",
              },
            ],
            note: "Continue from branch_eval_1 winner after validation.",
          },
        ]

        const out = await build({
          sessionID: session.id,
          phases: phase,
          query: "What branch won for src/router.ts?",
        })

        expect(out).toContain("branch_eval_1")
        expect(out).toContain("ses_task_1")
        expect(out).toContain("src/router.ts")
      },
    })
  })

  test("keeps shared context updates in durable memory after compaction", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const base = await user(session.id, "Continue the main task.")
        await assistant(session.id, base.id, [
          {
            type: "text",
            text: "Waiting for background branch results.",
          },
        ])
        await SessionMemory.extract({
          sessionID: session.id,
          messageID: base.id,
        })

        const shared = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: {
            providerID: "openai",
            modelID: "gpt-5.2",
          },
          time: {
            created: Date.now(),
          },
        })
        await text({
          sessionID: session.id,
          messageID: shared.id,
          synthetic: true,
          metadata: {
            shared_context: true,
            shared_context_cursor: "ctx_1",
            shared_context_count: 1,
          },
          text: [
            "Shared session context updates:",
            "- context=ctx_1 · task_result · branch winner · session=ses_branch · 2026-03-07T00:00:00.000Z",
            "Best branch passed bun test for src/router.ts and is ready to apply.",
          ].join("\n"),
        })
        await SessionMemory.extract({
          sessionID: session.id,
          messageID: shared.id,
        })
        await compact(session.id, "Shared branch result is ready to apply for src/router.ts.")

        const current = await user(session.id, "What did the background branch find for src/router.ts?")
        const msgs = await MessageV2.filterCompacted(MessageV2.stream(session.id))
        const built = await SessionContextBuilder.build({
          sessionID: session.id,
          model: model(),
          user: current,
          messages: msgs,
        })
        const out = JSON.stringify(built.messages[0] ?? "")

        expect(out).toContain("Shared branch result is ready to apply")
        expect(out).toContain("Best branch passed bun test")
        expect(out).toContain("src/router.ts")
      },
    })
  })
})
