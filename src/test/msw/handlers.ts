import { http, HttpResponse } from 'msw'

/** Add Supabase / edge-function mocks here as integration tests grow. */
export const handlers = [
  http.get('/api/health', () => HttpResponse.json({ ok: true })),
]
