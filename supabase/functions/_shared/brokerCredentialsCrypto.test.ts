import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  BrokerCredentialEncryptionError,
  decryptMtPassword,
  encryptMtPasswordRequired,
} from "./brokerCredentialsCrypto.ts"

function env(vars: Record<string, string>) {
  return { get: (name: string) => vars[name] }
}

Deno.test("required MT password encryption fails closed without a configured key", async () => {
  try {
    await encryptMtPasswordRequired("never-store-this", env({}))
  } catch (error) {
    assert(error instanceof BrokerCredentialEncryptionError)
    assertEquals(error.code, "ENCRYPTION_NOT_CONFIGURED")
    assertEquals(error.message.includes("never-store-this"), false)
    return
  }
  throw new Error("Expected encryption to fail closed")
})

Deno.test("required MT password encryption stores only versioned ciphertext", async () => {
  const password = "one-time broker password"
  const vars = env({ BROKER_CREDENTIALS_ENCRYPTION_KEY: "test-key-material" })
  const stored = await encryptMtPasswordRequired(password, vars)
  assert(stored.startsWith("v1:"))
  assert(stored !== password)
  assertEquals(stored.includes(password), false)
  assertEquals(await decryptMtPassword(stored, vars), password)
})

Deno.test("required MT password encryption accepts Deno.env-style primary and legacy keys", async () => {
  for (const keyName of [
    "BROKER_CREDENTIALS_ENCRYPTION_KEY",
    "BROKER_CREDENTIALS_KEY",
    "MT_PASSWORD_ENCRYPTION_KEY",
  ]) {
    const vars = env({ [keyName]: `material-for-${keyName}` })
    const stored = await encryptMtPasswordRequired("secret", vars)
    assert(stored.startsWith("v1:"))
    assertEquals(await decryptMtPassword(stored, vars), "secret")
  }
})
