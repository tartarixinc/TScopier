import { chromium } from '@playwright/test'

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})
await page.goto('http://127.0.0.1:4173/?site=marketing', { waitUntil: 'load' })
await page.waitForTimeout(3000)
const info = await page.evaluate(() => ({
  search: location.search,
  path: location.pathname,
  rootHtml: document.getElementById('root')?.innerHTML?.slice(0, 500) ?? null,
  bodyText: document.body?.innerText?.slice(0, 300) ?? null,
  hasMarketingHome: Boolean(document.querySelector('a[aria-label="TScopier home"]')),
  hasAuthHome: Boolean(document.querySelector('a[aria-label="TSCopier home"]')),
  h1: document.querySelector('h1')?.innerText?.slice(0, 120) ?? null,
}))
console.log(JSON.stringify({ ...info, errors }, null, 2))
await browser.close()
