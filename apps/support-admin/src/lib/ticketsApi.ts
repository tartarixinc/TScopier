import { supabase } from './supabase'

export type SupportTicketStatus = 'open' | 'pending' | 'resolved' | 'closed'

export type SupportTicket = {
  id: string
  number: number
  user_id: string | null
  guest_name: string | null
  guest_email: string | null
  guest_token: string | null
  subject: string
  status: SupportTicketStatus
  priority: string
  assignee_id: string | null
  last_message_at: string
  created_at: string
  updated_at: string
}

export type SupportTicketMessage = {
  id: string
  ticket_id: string
  sender_type: 'user' | 'agent' | 'system' | 'email_inbound'
  sender_user_id: string | null
  body: string
  images: string[]
  resend_id: string | null
  email_message_id: string | null
  created_at: string
}

export type TicketFilter = 'open' | 'mine' | 'all'

async function agentHeaders(): Promise<HeadersInit> {
  const { data, error } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (error || !token) throw new Error('Not signed in')
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  }
}

async function postTickets(body: Record<string, unknown>) {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/support-tickets`
  const res = await fetch(url, {
    method: 'POST',
    headers: await agentHeaders(),
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export async function listAgentTickets(
  filter: TicketFilter,
  agentUserId: string,
): Promise<SupportTicket[]> {
  const data = await postTickets({
    action: 'agent_list',
    filter,
    agent_user_id: agentUserId,
  })
  return (data.tickets as SupportTicket[]) ?? []
}

export async function getAgentTicket(ticketId: string): Promise<{
  ticket: SupportTicket
  messages: SupportTicketMessage[]
}> {
  const data = await postTickets({
    action: 'agent_get',
    ticket_id: ticketId,
  })
  return {
    ticket: data.ticket as SupportTicket,
    messages: (data.messages as SupportTicketMessage[]) ?? [],
  }
}

export async function claimTicket(ticketId: string): Promise<SupportTicket> {
  const data = await postTickets({ action: 'claim', ticket_id: ticketId })
  return data.ticket as SupportTicket
}

export async function updateTicketStatus(
  ticketId: string,
  status: SupportTicketStatus,
): Promise<SupportTicket> {
  const data = await postTickets({ action: 'update_status', ticket_id: ticketId, status })
  return data.ticket as SupportTicket
}

export async function replyToTicket(
  ticketId: string,
  message: string,
): Promise<SupportTicketMessage> {
  const data = await postTickets({
    action: 'agent_reply',
    ticket_id: ticketId,
    message,
  })
  return data.message as SupportTicketMessage
}
