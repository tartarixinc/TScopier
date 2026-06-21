import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/msw/server'

describe('MSW integration smoke', () => {
  it('returns mocked health payload', async () => {
    server.use(
      http.get('/api/health', () => HttpResponse.json({ ok: true, source: 'msw-test' })),
    )

    const res = await fetch('/api/health')
    const body = await res.json()
    expect(body).toEqual({ ok: true, source: 'msw-test' })
  })
})
