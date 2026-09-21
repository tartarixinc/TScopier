// AES-256-GCM encryption for broker passwords (Deno/Edge Runtime).
// Produces the same v1:iv:payload format as the worker's brokerCredentialsCrypto.ts.

const PREFIX = "v1";
const IV_LEN = 12;

function resolveEncryptionKeyRaw(env: Record<string, string | undefined>): string {
  return (
    (env.BROKER_CREDENTIALS_ENCRYPTION_KEY ?? "").trim()
    || (env.BROKER_CREDENTIALS_KEY ?? "").trim()
    || (env.MT_PASSWORD_ENCRYPTION_KEY ?? "").trim()
  );
}

function decodeKeyMaterial(raw: string): Uint8Array | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Hex-encoded 64-char key (32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  // Base64-encoded key
  try {
    const decoded = atob(trimmed);
    if (decoded.length === 32) {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) bytes[i] = decoded.charCodeAt(i);
      return bytes;
    }
  } catch { /* fall through */ }

  // Hash to 32 bytes using SHA-256
  return null; // Will be handled by hash fallback
}

async function getKey(env: Record<string, string | undefined>): Promise<CryptoKey | null> {
  const raw = resolveEncryptionKeyRaw(env);
  if (!raw) return null;

  const material = decodeKeyMaterial(raw);
  if (material) {
    return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  // Hash the raw string to 32 bytes via SHA-256
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(raw));
  return crypto.subtle.importKey("raw", hashBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptMtPassword(
  plaintext: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const password = plaintext.trim();
  if (!password) return null;

  const key = await getKey(env);
  if (!key) return null;

  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(password));

  // Split into ciphertext + tag (last 16 bytes)
  const payload = new Uint8Array(encrypted);
  const ivB64 = btoa(String.fromCharCode(...iv));
  const payloadB64 = btoa(String.fromCharCode(...payload));

  return `${PREFIX}:${ivB64}:${payloadB64}`;
}

export async function decryptMtPassword(
  stored: string | null | undefined,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const value = String(stored ?? "").trim();
  if (!value) return null;

  const parts = value.split(":");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;

  const key = await getKey(env);
  if (!key) return null;

  const iv = Uint8Array.from(atob(parts[1] ?? ""), c => c.charCodeAt(0));
  const payload = Uint8Array.from(atob(parts[2] ?? ""), c => c.charCodeAt(0));

  if (iv.length !== IV_LEN || payload.length < 16) return null;

  try {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, payload);
    return new TextDecoder().decode(decrypted).trim() || null;
  } catch {
    return null;
  }
}

export function isEncryptionConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(resolveEncryptionKeyRaw(env));
}
