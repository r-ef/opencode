import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCoordinator } from "../../src/session/coordinator"
import { SessionCoordinatorPlanTable, SessionCoordinatorWorkTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

function report(input: {
  summary: string
  topic: string
  statement: string
  verdict?: "report" | "confirm" | "contradict"
  evidence?: string[]
}) {
  return [
    input.summary,
    "",
    "<analysis_json>",
    JSON.stringify({
      summary: input.summary,
      claims: [
        {
          topic: input.topic,
          statement: input.statement,
          evidence: input.evidence ?? ["/tmp/demo.ts:1"],
          confidence: "high",
          verdict: input.verdict ?? "report",
        },
      ],
      risks: [],
      verify_topics: [input.topic],
    }),
    "</analysis_json>",
  ].join("\n")
}

function invalid(summary = "bad") {
  return `${summary}\n\n<analysis_json>{"summary":1}</analysis_json>`
}

describe("session coordinator", () => {
  test("creates a deterministic plan and primary workstreams for broad analysis", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })

        const plan = await SessionCoordinator.ensure({
          session_id: root.id,
          query: "analyze this codebase",
        })
        const run = await SessionCoordinator.schedule({
          session_id: root.id,
        })

        expect(plan?.status).toBe("planned")
        expect(plan?.requirements.verifier).toBe(1)
        expect(run.tasks).toHaveLength(3)
        expect(run.tasks.map((item) => item.agent)).toEqual(["explore", "explore", "explore"])
      },
    })
  })

  test("starts smaller by default for non-expansive analysis requests", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })

        const plan = await SessionCoordinator.ensure({
          session_id: root.id,
          query: "audit tests and architecture",
        })
        const run = await SessionCoordinator.schedule({
          session_id: root.id,
        })

        expect(plan?.requirements.primary).toBe(2)
        expect(run.tasks).toHaveLength(2)
      },
    })
  })

  test("binds scheduled workstreams to task sessions and ingests structured claims", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "review this repo",
        })
        const run = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        const child = await Session.create({ parentID: root.id, title: "child" })

        const bound = await SessionCoordinator.bind({
          parent_session_id: root.id,
          session_id: child.id,
          agent: run.tasks[0]!.agent,
          description: run.tasks[0]!.description,
          prompt: run.tasks[0]!.prompt,
        })

        expect(bound.prompt).not.toContain("coordination-workstream")

        await SessionCoordinator.complete({
          session_id: child.id,
          text: report({
            summary: "Mapped repository structure.",
            topic: "structure",
            statement: "The repo is split by package boundaries.",
          }),
        })

        const snap = await SessionCoordinator.get(root.id)
        expect(snap.claims).toHaveLength(1)
        expect(snap.claims[0]?.topic).toBe("structure")
        expect(snap.works.find((item) => item.session_id === child.id)?.status).toBe("completed")
      },
    })
  })

  test("accepts structured coordinator results without parsing text blocks", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "review this repo",
        })
        const run = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        const child = await Session.create({ parentID: root.id, title: "child" })
        await SessionCoordinator.bind({
          parent_session_id: root.id,
          session_id: child.id,
          agent: run.tasks[0]!.agent,
          description: run.tasks[0]!.description,
          prompt: run.tasks[0]!.prompt,
        })

        await SessionCoordinator.complete({
          session_id: child.id,
          text: "Mapped repository structure.",
          structured: {
            summary: "Mapped repository structure.",
            claims: [
              {
                topic: "structure",
                statement: "The repo is split by package boundaries.",
                evidence: ["/tmp/demo.ts:1"],
                confidence: "high",
                verdict: "report",
              },
            ],
            risks: [],
            verify_topics: ["structure"],
          },
        })

        const snap = await SessionCoordinator.get(root.id)
        expect(snap.claims).toHaveLength(1)
        expect(snap.claims[0]?.topic).toBe("structure")
      },
    })
  })

  test("accepts summary-only reports when no claims are confident", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "review this repo",
        })
        const run = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        const child = await Session.create({ parentID: root.id, title: "child" })
        await SessionCoordinator.bind({
          parent_session_id: root.id,
          session_id: child.id,
          agent: run.tasks[0]!.agent,
          description: run.tasks[0]!.description,
          prompt: run.tasks[0]!.prompt,
        })

        await SessionCoordinator.complete({
          session_id: child.id,
          text: [
            "No confident claims.",
            "",
            "<analysis_json>",
            JSON.stringify({
              summary: "No confident claims.",
              claims: [],
              risks: ["Coverage is incomplete."],
              verify_topics: [],
            }),
            "</analysis_json>",
          ].join("\n"),
        })

        const snap = await SessionCoordinator.get(root.id)
        expect(snap.claims).toHaveLength(0)
        expect(snap.works.find((item) => item.session_id === child.id)?.status).toBe("completed")
      },
    })
  })

  test("does not bind untagged subtasks into coordinator accounting", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "review this repo",
        })
        await SessionCoordinator.schedule({
          session_id: root.id,
        })
        const child = await Session.create({ parentID: root.id, title: "manual" })

        const bound = await SessionCoordinator.bind({
          parent_session_id: root.id,
          session_id: child.id,
          agent: "explore",
          description: "manual",
          prompt: "manual prompt",
        })

        expect(bound.work_id).toBeUndefined()
        expect(bound.prompt).toBe("manual prompt")

        await SessionCoordinator.complete({
          session_id: child.id,
          text: report({
            summary: "manual",
            topic: "manual",
            statement: "should not count",
          }),
        })

        const snap = await SessionCoordinator.get(root.id)
        expect(snap.works.some((item) => item.session_id === child.id)).toBeFalse()
      },
    })
  })

  test("schedules a verifier after required primary work completes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "audit tests and architecture",
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
            text: report({
              summary: `Primary ${idx}`,
              topic: `topic-${idx}`,
              statement: `statement-${idx}`,
            }),
          })
        }

        const next = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        expect(next.tasks).toHaveLength(1)
        expect(next.tasks[0]?.agent).toBe("general")
        expect(next.tasks[0]?.description).toBe("verify findings")
      },
    })
  })

  test("schedules a verifier for summary-only primaries and carries focus hints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "audit tests and architecture",
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
                claims: [],
                risks: [],
                verify_topics: [`focus-${idx}`],
              }),
              "</analysis_json>",
            ].join("\n"),
          })
        }

        const next = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        expect(next.tasks).toHaveLength(1)
        expect(next.tasks[0]?.description).toBe("verify findings")
        expect(next.tasks[0]?.prompt).toContain("Additional focus areas:")
        expect(next.tasks[0]?.prompt).toContain("focus-0")

        const child = await Session.create({ parentID: root.id, title: "verifier" })
        await SessionCoordinator.bind({
          parent_session_id: root.id,
          session_id: child.id,
          agent: next.tasks[0]!.agent,
          description: next.tasks[0]!.description,
          prompt: next.tasks[0]!.prompt,
        })
        await SessionCoordinator.complete({
          session_id: child.id,
          text: [
            "Verifier",
            "",
            "<analysis_json>",
            JSON.stringify({
              summary: "Verifier",
              claims: [],
              risks: [],
              verify_topics: [],
            }),
            "</analysis_json>",
          ].join("\n"),
        })

        const snap = await SessionCoordinator.get(root.id)
        expect(snap.plan?.status).toBe("ready_to_finalize")
        expect(snap.counts.verifier.completed).toBe(1)
      },
    })
  })

  test("schedules a reconciler when verifier contradicts a primary claim", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "analyze this repo",
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
            text: report({
              summary: `Primary ${idx}`,
              topic: idx === 0 ? "parser" : `topic-${idx}`,
              statement: idx === 0 ? "Fallback is reachable." : `aux-${idx}`,
            }),
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
          text: report({
            summary: "Verifier disagrees.",
            topic: "parser",
            statement: "Fallback is not reachable.",
            verdict: "contradict",
            evidence: ["/tmp/demo.ts:1"],
          }),
          structured: {
            summary: "Verifier disagrees.",
            claims: [
              {
                topic: "parser",
                statement: "Fallback is not reachable.",
                evidence: ["/tmp/demo.ts:1"],
                confidence: "high",
                verdict: "contradict",
              },
              {
                topic: "topic-1",
                statement: "aux-1",
                evidence: ["/tmp/demo.ts:1"],
                confidence: "high",
                verdict: "confirm",
              },
              {
                topic: "topic-2",
                statement: "aux-2",
                evidence: ["/tmp/demo.ts:1"],
                confidence: "high",
                verdict: "confirm",
              },
            ],
            risks: [],
            verify_topics: ["parser", "topic-1", "topic-2"],
          },
        })

        const next = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        const snap = await SessionCoordinator.get(root.id)
        expect(snap.plan?.status).toBe("awaiting_reconcile")
        expect(next.tasks[0]?.description).toBe("resolve conflict")
      },
    })
  })

  test("fails verifier runs that do not cover every requested topic", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "analyze this repo",
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
            text: report({
              summary: `Primary ${idx}`,
              topic: `topic-${idx}`,
              statement: `statement-${idx}`,
            }),
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
                  evidence: ["/tmp/demo.ts:1"],
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

        const snap = await SessionCoordinator.get(root.id)
        const row = snap.works.find((item) => item.session_id === child.id)
        expect(row?.status).toBe("failed")
        expect(row?.metadata?.error).toContain("Verification did not cover all requested topics")
        expect(snap.plan?.status).toBe("awaiting_verification")
      },
    })
  })

  test("retry verification preserves additional focus areas", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "audit tests and architecture",
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
                claims: [],
                risks: [],
                verify_topics: [`focus-${idx}`],
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
        await SessionCoordinator.fail({
          session_id: child.id,
          error: "forced verifier failure",
        })

        const next = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        expect(next.tasks).toHaveLength(1)
        expect(next.tasks[0]?.description).toBe("retry verification")
        expect(next.tasks[0]?.prompt).toContain("Additional focus areas:")
        expect(next.tasks[0]?.prompt).toContain("focus-0")
      },
    })
  })

  test("retries a workstream when the structured report is invalid", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "analyze this repo",
        })
        const first = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        const child = await Session.create({ parentID: root.id, title: "child" })
        await SessionCoordinator.bind({
          parent_session_id: root.id,
          session_id: child.id,
          agent: first.tasks[0]!.agent,
          description: first.tasks[0]!.description,
          prompt: first.tasks[0]!.prompt,
        })
        await SessionCoordinator.complete({
          session_id: child.id,
          text: invalid(),
        })

        const next = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        const snap = await SessionCoordinator.get(root.id)
        expect(next.tasks.length).toBeGreaterThan(0)
        expect(snap.works.some((item) => item.status === "failed")).toBeTrue()
      },
    })
  })

  test("normalizes overlapping topics and rejects invalid evidence", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(`${tmp.path}/demo.ts`, "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "review this repo",
        })
        const first = await SessionCoordinator.schedule({
          session_id: root.id,
        })

        const one = await Session.create({ parentID: root.id, title: "one" })
        await SessionCoordinator.bind({
          parent_session_id: root.id,
          session_id: one.id,
          agent: first.tasks[0]!.agent,
          description: first.tasks[0]!.description,
          prompt: first.tasks[0]!.prompt,
        })
        await SessionCoordinator.complete({
          session_id: one.id,
          text: report({
            summary: "build",
            topic: "CI pipeline",
            statement: "The build pipeline runs through a single script.",
            evidence: [`${tmp.path}/demo.ts:1`],
          }),
        })

        const two = await Session.create({ parentID: root.id, title: "two" })
        await SessionCoordinator.bind({
          parent_session_id: root.id,
          session_id: two.id,
          agent: first.tasks[1]!.agent,
          description: first.tasks[1]!.description,
          prompt: first.tasks[1]!.prompt,
        })
        await SessionCoordinator.complete({
          session_id: two.id,
          text: report({
            summary: "build again",
            topic: "build pipeline",
            statement: "The build pipeline runs through a single script.",
            evidence: ["/missing.ts:99"],
          }),
        })

        const snap = await SessionCoordinator.get(root.id)
        expect(snap.claims.filter((item) => item.status !== "rejected")).toHaveLength(1)
        expect(snap.claims[0]?.metadata?.normalized).toContain("build")
        expect(snap.works.find((item) => item.session_id === two.id)?.status).toBe("failed")
      },
    })
  })

  test("marks stale work as failed and schedules reassignment", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "analyze this repo",
        })
        const first = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        const child = await Session.create({ parentID: root.id, title: "child" })
        await SessionCoordinator.bind({
          parent_session_id: root.id,
          session_id: child.id,
          agent: first.tasks[0]!.agent,
          description: first.tasks[0]!.description,
          prompt: first.tasks[0]!.prompt,
        })
        const row = (await SessionCoordinator.get(root.id)).works.find((item) => item.session_id === child.id)
        if (!row) throw new Error("missing work")
        Database.use((db) =>
          db
            .update(SessionCoordinatorWorkTable)
            .set({
              metadata: {
                ...(row.metadata ?? {}),
                timeout_at: Date.now() - 1,
              },
            })
            .where(eq(SessionCoordinatorWorkTable.id, row.id))
            .run(),
        )

        const next = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        const snap = await SessionCoordinator.get(root.id)
        expect(snap.works.some((item) => item.status === "failed")).toBeTrue()
        expect(next.tasks.length).toBeGreaterThan(0)
      },
    })
  })

  test("creates a fresh plan after the previous one is exhausted", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const first = await SessionCoordinator.ensure({
          session_id: root.id,
          query: "analyze this codebase",
        })
        const run = await SessionCoordinator.schedule({
          session_id: root.id,
        })
        for (const [idx, item] of run.tasks.entries()) {
          const child = await Session.create({ parentID: root.id, title: `child-${idx}` })
          await SessionCoordinator.bind({
            parent_session_id: root.id,
            session_id: child.id,
            agent: item.agent,
            description: item.description,
            prompt: item.prompt,
          })
          await SessionCoordinator.fail({
            session_id: child.id,
            error: "forced failure",
          })
        }

        const next = await SessionCoordinator.ensure({
          session_id: root.id,
          query: "analyze this codebase",
        })

        expect(next?.id).not.toBe(first?.id)
      },
    })
  })

  test("get refreshes stale coordinator snapshots", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write("/tmp/demo.ts", "export const demo = 1\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await SessionCoordinator.ensure({
          session_id: root.id,
          query: "audit tests and architecture",
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
                claims: [],
                risks: [],
                verify_topics: [],
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
              claims: [],
              risks: [],
              verify_topics: [],
            }),
            "</analysis_json>",
          ].join("\n"),
        })

        const row = (await SessionCoordinator.get(root.id)).plan
        if (!row) throw new Error("missing plan")
        Database.use((db) =>
          db
            .update(SessionCoordinatorPlanTable)
            .set({
              status: "planned",
              summary: "stale",
            })
            .where(eq(SessionCoordinatorPlanTable.id, row.id))
            .run(),
        )

        const snap = await SessionCoordinator.get(root.id)
        expect(snap.plan?.status).toBe("ready_to_finalize")
        expect(snap.summary).not.toBe("stale")
      },
    })
  })
})
