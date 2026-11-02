// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TraderReviews } from './TraderReviews'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  fetchReviews: vi.fn(),
  saveReview: vi.fn(),
}))

vi.mock('../../lib/supabase', () => ({ supabase: {} }))

vi.mock('../../lib/socialReviews', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/socialReviews')>(),
  fetchSocialTraderReviews: mocks.fetchReviews,
  saveSocialTraderReview: mocks.saveReview,
}))

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  mocks.fetchReviews.mockReset()
  mocks.saveReview.mockReset()
})

describe('TraderReviews rating action', () => {
  it('renders only stars in compact mode and opens the existing review modal', async () => {
    mocks.fetchReviews.mockResolvedValueOnce([])
    await act(async () => {
      root.render(createElement(TraderReviews, {
        traderUserId: 'trader-id', traderName: 'Ada', isSelf: false,
        averageRating: null, reviewCount: 0, compact: true,
      }))
    })

    const ratingAction = container.querySelector<HTMLButtonElement>('button[aria-label="Rate Ada"]')
    expect(ratingAction).not.toBeNull()
    expect(ratingAction?.querySelectorAll('svg')).toHaveLength(5)
    expect(ratingAction?.textContent).toBe('')
    expect(container.textContent).not.toContain('Rate trader')
    expect(container.textContent).not.toContain('No ratings')
    expect(container.textContent).not.toContain('(0)')

    await act(async () => {
      ratingAction!.click()
      await Promise.resolve()
    })
    expect(document.querySelector('#trader-review-title')?.textContent).toBe('Rate trader')
  })

  it('preserves the expanded profile summary and written reviews', async () => {
    mocks.fetchReviews.mockResolvedValueOnce([{
      reviewId: 'review-1', rating: 5, reviewText: 'Clear and consistent.',
      reviewerDisplayName: 'Demo Reviewer', reviewerUsername: 'demo-reviewer',
      isOwn: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    }])
    await act(async () => {
      root.render(createElement(TraderReviews, {
        traderUserId: 'trader-id', traderName: 'Ada', isSelf: false,
        averageRating: 5, reviewCount: 1, expanded: true,
      }))
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Trader reviews')
    expect(container.textContent).toContain('5.0 (1)')
    expect(container.textContent).toContain('Rate trader')
    expect(container.textContent).toContain('Clear and consistent.')
  })

  it('shows loading and retry feedback without opening an invalid review modal', async () => {
    const firstRequest = deferred<never[]>()
    mocks.fetchReviews.mockReturnValueOnce(firstRequest.promise)

    await act(async () => {
      root.render(createElement(TraderReviews, {
        traderUserId: 'trader-id',
        traderName: 'Ada',
        isSelf: false,
        averageRating: 4.5,
        reviewCount: 2,
      }))
    })

    const ratingAction = container.querySelector<HTMLButtonElement>('button[aria-label="Rate Ada"]')
    expect(ratingAction).not.toBeNull()

    await act(async () => {
      ratingAction!.click()
      await Promise.resolve()
    })
    expect(ratingAction?.getAttribute('aria-busy')).toBe('true')
    expect(ratingAction?.textContent).toContain('Loading reviews')

    await act(async () => {
      firstRequest.reject(new Error('database details must remain hidden'))
      await Promise.resolve()
    })

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Unable to load reviews. Please try again.')
    expect(container.textContent).not.toContain('database details')

    mocks.fetchReviews.mockResolvedValueOnce([])
    const retry = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Retry loading reviews'))
    expect(retry).toBeDefined()

    await act(async () => {
      retry!.click()
      await Promise.resolve()
    })

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('#trader-review-title')?.textContent).toBe('Rate trader')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
