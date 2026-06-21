import { test, expect } from '@playwright/test'

test.describe('marketing site', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto('/?site=marketing')
    await expect(page).toHaveURL(/\?site=marketing/)
    await expect(page.locator('.animate-spin')).toBeHidden({ timeout: 30_000 })
    await expect(page.getByRole('link', { name: 'TScopier home' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      /Turn Telegram Signals Into Live Trades/i,
    )
  })
})

test.describe('app shell', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/login')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.locator('.animate-spin')).toBeHidden({ timeout: 30_000 })
    await expect(page.getByRole('link', { name: /TSCopier home/i })).toBeVisible()
  })
})
