import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { buildProviderApprovalEmail } from "./providerDecisionEmail.ts"

const base = { appUrl: "https://app.tscopier.ai/", logoUrl: "https://app.tscopier.ai/logo.png" }

Deno.test("approval email greets the provider and links the public profile", () => {
  const { subject, html } = buildProviderApprovalEmail({ ...base, name: "Martins", slug: "martins-osodi" })
  assertEquals(subject, "You're approved as a UniCopier provider")
  assert(html.includes("Hi Martins,"))
  assert(html.includes("https://app.tscopier.ai/p/martins-osodi"))
  assert(html.includes("https://app.tscopier.ai/social-trading/provider"))
})

Deno.test("reinstated providers get a different subject", () => {
  const { subject, html } = buildProviderApprovalEmail({ ...base, name: "A", slug: "a-b", reinstated: true })
  assertEquals(subject, "Your UniCopier provider profile is live again")
  assert(html.includes("reinstated"))
})

Deno.test("name falls back, slug is optional and html is escaped", () => {
  const { html } = buildProviderApprovalEmail({ ...base, name: "<b>x</b>", slug: null })
  assert(html.includes("&lt;b&gt;x&lt;/b&gt;"))
  assertFalse(html.includes("/p/"))
  assert(buildProviderApprovalEmail({ ...base, name: "  ", slug: null }).html.includes("Hi there,"))
})
