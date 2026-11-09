import { supabase } from './supabase'
import { ensureFreshAuthSession } from './fxsocketBroker'
import {
  ASSISTANT_MAX_IMAGES,
  fileToAssistantImageDataUrl,
  isAssistantImageType,
} from './assistantImages'

export const SUPPORT_MAX_IMAGES = ASSISTANT_MAX_IMAGES
export const SUPPORT_ATTACHMENTS_BUCKET = 'support-attachments'
export const SUPPORT_GUEST_STORAGE_KEY = 'tscopier-support-guest'

export type SupportConversationStatus = 'ai' | 'queued' | 'active' | 'resolved'

export type SupportSenderType = 'user' | 'ai' | 'agent' | 'system'

export type SupportGuestSession = {
  name: string
  email: string
  token: string
  conversationId: string | null
}

export type SupportConversation = {
  id: string
  user_id: string | null
  status: SupportConversationStatus
  assignee_id: string | null
  subject: string | null
  last_message_at: string
  created_at: string
  updated_at: string
  guest_name?: string | null
  guest_email?: string | null
  guest_token?: string | null
}

export type SupportMessage = {
  id: string
  conversation_id: string
  sender_type: SupportSenderType
  sender_user_id: string | null
  body: string
  images: string[]
  created_at: string
}

export type SupportChatSendResult = {
  conversation_id: string
  status: SupportConversationStatus
  guest_token?: string | null
  user_message: SupportMessage
  ai_message: SupportMessage | null
  escalated: boolean
}

function anonHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY as string}`,
  }
}

async function authOrAnonHeaders(): Promise<HeadersInit> {
  try {
    const token = await ensureFreshAuthSession()
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    }
  } catch {
    return anonHeaders()
  }
}

function normalizeMessage(row: SupportMessage): SupportMessage {
  return {
    ...row,
    images: Array.isArray(row.images) ? row.images.filter(Boolean) : [],
  }
}

export function readSupportGuestSession(): SupportGuestSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SUPPORT_GUEST_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SupportGuestSession>
    if (!parsed?.token || !parsed?.email || !parsed?.name) return null
    return {
      name: String(parsed.name),
      email: String(parsed.email),
      token: String(parsed.token),
      conversationId: parsed.conversationId ? String(parsed.conversationId) : null,
    }
  } catch {
    return null
  }
}

export function writeSupportGuestSession(session: SupportGuestSession): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SUPPORT_GUEST_STORAGE_KEY, JSON.stringify(session))
}

export function clearSupportGuestSession(): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(SUPPORT_GUEST_STORAGE_KEY)
}

export async function listSupportConversations(): Promise<SupportConversation[]> {
  const { data, error } = await supabase
    .from('support_conversations')
    .select('*')
    .order('last_message_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as SupportConversation[]
}

export async function listSupportMessages(conversationId: string): Promise<SupportMessage[]> {
  const { data, error } = await supabase
    .from('support_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as SupportMessage[]).map(normalizeMessage)
}

export async function listGuestSupportMessages(params: {
  guestToken: string
  conversationId?: string | null
}): Promise<{ conversation: SupportConversation; messages: SupportMessage[] }> {
  const headers = anonHeaders()
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/support-chat`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'list',
      guest_token: params.guestToken,
      conversation_id: params.conversationId ?? undefined,
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    error?: string
    conversation?: SupportConversation
    messages?: SupportMessage[]
  }
  if (!res.ok) throw new Error(data.error || `Failed to load messages (${res.status})`)
  return {
    conversation: data.conversation as SupportConversation,
    messages: (data.messages ?? []).map(normalizeMessage),
  }
}

export async function ensureOpenSupportConversation(userId: string): Promise<string> {
  const { data: existing, error: existingErr } = await supabase
    .from('support_conversations')
    .select('id')
    .eq('user_id', userId)
    .in('status', ['ai', 'queued', 'active'])
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingErr) throw new Error(existingErr.message)
  if (existing?.id) return existing.id as string

  const { data: created, error: createErr } = await supabase
    .from('support_conversations')
    .insert({ user_id: userId, status: 'ai' })
    .select('id')
    .single()
  if (createErr || !created) throw new Error(createErr?.message ?? 'Failed to start conversation')
  return created.id as string
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl)
  if (!match) throw new Error('invalid_data_url')
  const mime = match[1]
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export async function uploadSupportImages(params: {
  userId: string
  conversationId: string
  dataUrls: string[]
}): Promise<string[]> {
  const urls: string[] = []
  for (const dataUrl of params.dataUrls.slice(0, SUPPORT_MAX_IMAGES)) {
    const blob = dataUrlToBlob(dataUrl)
    const ext = blob.type.includes('png')
      ? 'png'
      : blob.type.includes('webp')
        ? 'webp'
        : blob.type.includes('gif')
          ? 'gif'
          : 'jpg'
    const path = `${params.userId}/${params.conversationId}/${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage.from(SUPPORT_ATTACHMENTS_BUCKET).upload(path, blob, {
      contentType: blob.type || 'image/jpeg',
      upsert: false,
      cacheControl: '3600',
    })
    if (error) throw new Error(error.message)
    const { data } = supabase.storage.from(SUPPORT_ATTACHMENTS_BUCKET).getPublicUrl(path)
    urls.push(data.publicUrl)
  }
  return urls
}

export async function filesToSupportImageDataUrls(files: FileList | File[]): Promise<string[]> {
  const list = Array.from(files).filter(f => isAssistantImageType(f.type))
  const out: string[] = []
  for (const file of list.slice(0, SUPPORT_MAX_IMAGES)) {
    out.push(await fileToAssistantImageDataUrl(file))
  }
  return out
}

export async function sendSupportMessage(params: {
  message: string
  conversationId?: string | null
  images?: string[]
  imageDataUrls?: string[]
  guest?: { name: string; email: string; token?: string | null } | null
}): Promise<SupportChatSendResult> {
  const headers = params.guest ? anonHeaders() : await authOrAnonHeaders()
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/support-chat`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'send',
      message: params.message,
      conversation_id: params.conversationId ?? undefined,
      images: params.images?.length ? params.images : undefined,
      image_data_urls: params.imageDataUrls?.length ? params.imageDataUrls : undefined,
      guest_name: params.guest?.name,
      guest_email: params.guest?.email,
      guest_token: params.guest?.token ?? undefined,
    }),
  })
  const data = (await res.json().catch(() => ({}))) as SupportChatSendResult & { error?: string }
  if (!res.ok) throw new Error(data.error || `Support chat failed (${res.status})`)
  return {
    ...data,
    user_message: normalizeMessage(data.user_message),
    ai_message: data.ai_message ? normalizeMessage(data.ai_message) : null,
  }
}

export async function escalateSupportConversation(
  conversationId: string,
  guest?: { token: string } | null,
): Promise<void> {
  if (!guest) {
    const { error } = await supabase.rpc('support_escalate_conversation', {
      p_conversation_id: conversationId,
    })
    if (!error) return
  }

  const headers = guest ? anonHeaders() : await authOrAnonHeaders()
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/support-chat`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'escalate',
      conversation_id: conversationId,
      guest_token: guest?.token,
    }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(data.error || 'Failed to escalate')
}

export function loginUrlForSupportReturn(): string {
  const returnTo =
    typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.search}${window.location.hash}`
      : '/dashboard'
  const params = new URLSearchParams({ returnTo })
  return `/login?${params.toString()}`
}
