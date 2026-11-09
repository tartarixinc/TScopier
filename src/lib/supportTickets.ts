import { ensureFreshAuthSession } from './fxsocketBroker'
import {
  readSupportGuestSession,
  type SupportGuestSession,
} from './supportChat'

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

async function postTickets(body: Record<string, unknown>, authed: boolean) {
  const headers = authed ? await authOrAnonHeaders() : anonHeaders()
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/support-tickets`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string
  }
  if (!res.ok) throw new Error(data.error || `Ticket request failed (${res.status})`)
  return data
}

export async function createSupportTicket(params: {
  subject: string
  message: string
  guest?: { name: string; email: string; token?: string | null } | null
}): Promise<{ ticket: SupportTicket; guest_token?: string | null }> {
  const data = await postTickets(
    {
      action: 'create',
      subject: params.subject,
      message: params.message,
      guest_name: params.guest?.name,
      guest_email: params.guest?.email,
      guest_token: params.guest?.token ?? undefined,
    },
    !params.guest,
  )
  return {
    ticket: data.ticket as SupportTicket,
    guest_token: (data.guest_token as string | null | undefined) ?? null,
  }
}

export async function listMySupportTickets(guest?: SupportGuestSession | null): Promise<SupportTicket[]> {
  const data = await postTickets(
    {
      action: 'list',
      guest_token: guest?.token,
      guest_name: guest?.name,
      guest_email: guest?.email,
    },
    !guest,
  )
  return (data.tickets as SupportTicket[]) ?? []
}

export function guestForTickets(): SupportGuestSession | null {
  return readSupportGuestSession()
}
