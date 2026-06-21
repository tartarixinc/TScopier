import { assertEquals } from 'jsr:@std/assert@1'
import { extractHtmlNewsLinks, plainNewsText } from './stripHtml.ts'

Deno.test('plainNewsText returns plain strings unchanged', () => {
  assertEquals(plainNewsText('  Gold holds support  '), 'Gold holds support')
})

Deno.test('plainNewsText strips simple HTML', () => {
  assertEquals(plainNewsText('<p>Hello <strong>world</strong></p>'), 'Hello world')
})

Deno.test('extractHtmlNewsLinks dedupes by href', () => {
  const links = extractHtmlNewsLinks(
    '<ul><li><a href="https://example.com/a">First</a></li></ul>',
    '<p><a href="https://example.com/a">Duplicate</a></p>',
  )
  assertEquals(links.length, 1)
  assertEquals(links[0]?.href, 'https://example.com/a')
  assertEquals(links[0]?.text, 'First')
})
