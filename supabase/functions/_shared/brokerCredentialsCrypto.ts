const PREFIX = "v1"
const IV_LEN = 12

function trimEnv(env: { get(name: string): string | undefined }, key: string): string {
  return String(env.get(key) ?? "").trim()
}

function resolveEncryptionKeyRaw(env: { get(name: string): string | undefined }): string {
  return (
    trimEnv(env, "BROKER_CREDENTIALS_ENCRYPTION_KEY")
    || trimEnv(env, "BROKER_CREDENTIALS_KEY")
    || trimEnv(env, "MT_PASSWORD_ENCRYPTION_KEY")
  )
}

async function decodeKeyMaterial(raw: string): Promise<Uint8Array | null> {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16)
    }
    return bytes
  }

  try {
    const bin = atob(trimmed)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    if (bytes.length === 32) return bytes
  } catch {
    /* fall through */
  }

  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(trimmed)),
  )
  return digest
}

function toB64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function fromB64(value: string): Uint8Array | null {
  try {
    const bin = atob(value)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

async function importAesKey(env: { get(name: string): string | undefined }): Promise<CryptoKey | null> {
  const raw = resolveEncryptionKeyRaw(env)
  if (!raw) return null
  const keyBytes = await decodeKeyMaterial(raw)
  if (!keyBytes || keyBytes.length !== 32) return null
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ])
}

export function isBrokerCredentialsCryptoConfigured(
  env: { get(name: string): string | undefined },
): boolean {
  return Boolean(resolveEncryptionKeyRaw(env))
}

export async function encryptMtPassword(
  plaintext: string,
  env: { get(name: string): string | undefined },
): Promise<string | null> {
  const password = plaintext.trim()
  if (!password) return null
  const key = await importAesKey(env)
  if (!key) return null

  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    new TextEncoder().encode(password),
  )
  return `${PREFIX}:${toB64(iv)}:${toB64(new Uint8Array(cipher))}`
}

export async function decryptMtPassword(
  stored: string | null | undefined,
  env: { get(name: string): string | undefined },
): Promise<string | null> {
  const value = String(stored ?? "").trim()
  if (!value) return null

  const parts = value.split(":")
  if (parts.length !== 3 || parts[0] !== PREFIX) return null

  const iv = fromB64(parts[1] ?? "")
  const cipher = fromB64(parts[2] ?? "")
  if (!iv || !cipher || iv.length !== IV_LEN) return null

  const key = await importAesKey(env)
  if (!key) return null

  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      cipher,
    )
    const decoded = new TextDecoder().decode(plain).trim()
    return decoded || null
  } catch {
    return null
  }
}
