import { test, expect } from "../fixtures"
import { cleanupTestProject, openSidebar } from "../actions"
import { promptSelector, workspaceItemSelector } from "../selectors"
import { createSdk, dirSlug, sessionPath } from "../utils"

test("branch sessions show their workspaces in the sidebar", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withProject(async ({ directory, slug: root }) => {
    const sdk = createSdk(directory)
    const title = `e2e branch ${Date.now()}`
    const session = await sdk.session.create({ title }).then((x) => x.data)
    if (!session?.id) throw new Error("Session create did not return an id")

    const branch = await sdk.session.branch({ sessionID: session.id }).then((x) => x.data)
    if (!branch?.id || !branch.directory) throw new Error("Session branch did not return a branch")

    const slug = dirSlug(branch.directory)

    try {
      await page.goto(sessionPath(branch.directory, branch.id))
      await expect(page.locator(promptSelector)).toBeVisible()

      await openSidebar(page)
      await expect(page.getByRole("button", { name: "New workspace" }).first()).toBeVisible()
      await expect(page.locator(workspaceItemSelector(root)).first()).toBeVisible()
      await expect(page.locator(workspaceItemSelector(slug)).first()).toBeVisible()
    } finally {
      await createSdk(branch.directory)
        .session.delete({ sessionID: branch.id })
        .catch(() => undefined)
      await sdk.session.delete({ sessionID: session.id }).catch(() => undefined)
      await cleanupTestProject(branch.directory)
    }
  })
})