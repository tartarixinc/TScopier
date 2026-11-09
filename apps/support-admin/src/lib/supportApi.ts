import { supabase } from './supabase'

export type SupportConversationStatus = 'ai' | 'queued' | 'active' | 'resolved'

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
}

export type SupportMessage = {
  id: string
  conversation_id: string
  sender_type: 'user' | 'ai' | 'agent' | 'system'
  sender_user_id: string | null
  body: string
  images?: string[] | null
  created_at: string
}

export type InboxFilter = 'queued' | 'mine' | 'all'

export type UserContext = {
  user_id: string
  display_name: string | null
  username: string | null
  first_name: string | null
  last_name: string | null
}

export async function listInboxConversations(
  filter: InboxFilter,
  agentUserId: string,
): Promise<SupportConversation[]> {
  let q = supabase
    .from('support_conversations')
    .select('*')
    .order('last_message_at', { ascending: false })
    .limit(100)

  if (filter === 'queued') q = q.eq('status', 'queued')
  else if (filter === 'mine') q = q.eq('assignee_id', agentUserId).in('status', ['active', 'queued'])
  else q = q.in('status', ['queued', 'active', 'ai', 'resolved'])

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as SupportConversation[]
}

export async function listMessages(conversationId: string): Promise<SupportMessage[]> {
  const { data, error } = await supabase
    .from('support_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as SupportMessage[]
}

export async function claimConversation(conversationId: string): Promise<void> {
  const { error } = await supabase.rpc('support_claim_conversation', {
    p_conversation_id: conversationId,
  })
  if (error) throw new Error(error.message)
}

export async function resolveConversation(conversationId: string): Promise<void> {
  const { error } = await supabase.rpc('support_resolve_conversation', {
    p_conversation_id: conversationId,
  })
  if (error) throw new Error(error.message)
}

export async function replyAsAgent(params: {
  conversationId: string
  agentUserId: string
  body: string
  images?: string[]
}): Promise<SupportMessage> {
  const images = (params.images ?? []).filter(Boolean).slice(0, 3)
  const body = params.body.trim() || (images.length ? 'Shared an image' : '')
  if (!body && images.length === 0) throw new Error('Message or image required')

  const { data, error } = await supabase
    .from('support_messages')
    .insert({
      conversation_id: params.conversationId,
      sender_type: 'agent',
      sender_user_id: params.agentUserId,
      body,
      images,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data as SupportMessage
}

export async function fetchUserContext(userId: string): Promise<UserContext | null> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('user_id, display_name, username, first_name, last_name')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return null
  return data as UserContext
}
