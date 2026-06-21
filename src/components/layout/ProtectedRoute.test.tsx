import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './ProtectedRoute'

vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}))

vi.mock('../../context/UserProfileContext', () => ({
  useUserProfile: vi.fn(),
}))

import { useAuth } from '../../context/AuthContext'
import { useUserProfile } from '../../context/UserProfileContext'

function renderProtected(initialPath = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<div>Login page</div>} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <div>Dashboard secret</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.mocked(useUserProfile).mockReturnValue({
      loading: false,
      emailVerifiedAt: '2026-01-01T00:00:00Z',
    } as ReturnType<typeof useUserProfile>)
  })

  it('shows loading spinner while auth is loading', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      session: null,
      loading: true,
      signOut: vi.fn(),
    })

    renderProtected()
    expect(screen.queryByText('Dashboard secret')).not.toBeInTheDocument()
    expect(document.querySelector('.animate-spin')).toBeTruthy()
  })

  it('redirects unauthenticated users away from dashboard', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      session: null,
      loading: false,
      signOut: vi.fn(),
    })

    renderProtected()
    expect(screen.queryByText('Dashboard secret')).not.toBeInTheDocument()
  })

  it('renders children for verified authenticated users', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: {
        id: 'user-1',
        email: 'trader@example.com',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      } as never,
      session: {} as never,
      loading: false,
      signOut: vi.fn(),
    })

    renderProtected()
    expect(screen.getByText('Dashboard secret')).toBeInTheDocument()
  })
})
