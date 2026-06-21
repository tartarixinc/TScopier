import { test, expect } from '@playwright/test'

/**
 * Regression suite — stable routes and host switching that broke in the past.
 * Tagged @regression for optional filtering: npx playwright test --grep @regression
 */

test.describe('host routing @regression', () => {
  test('marketing query param keeps landing on /', async ({ page }) => {
    await page.goto('/?site=marketing')
    await expect(page).toHaveURL(/\?site=marketing/)
    await expect(page.locator('.animate-spin')).toBeHidden({ timeout: 30_000 })
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('app host serves auth routes', async ({ page }) => {
    await page.goto('/signup')
    await expect(page).toHaveURL(/\/signup/)
    await expect(page.locator('.animate-spin')).toBeHidden({ timeout: 30_000 })
  })
})

test.describe('auth regression @regression', () => {
  test('unauthenticated dashboard redirects to login', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)
  })

  test('forgot-password route is reachable', async ({ page }) => {
    await page.goto('/forgot-password')
    await expect(page).toHaveURL(/\/forgot-password/)
    await expect(page.locator('.animate-spin')).toBeHidden({ timeout: 30_000 })
  })
})

test.describe('marketing navigation @regression', () => {
  test('pricing anchor is present on landing', async ({ page }) => {
    await page.goto('/?site=marketing')
    await expect(page.locator('.animate-spin')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('a[href="#pricing"]').first()).toBeVisible()
  })
})
