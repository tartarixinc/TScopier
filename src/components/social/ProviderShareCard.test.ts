import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AccountKindBadge } from './AccountKindBadge'
import { ProviderShareCard } from './ProviderShareCard'

describe('ProviderShareCard', () => {
  it('renders the public link, share targets and a QR code for the slug', () => {
    const markup = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(ProviderShareCard, { slug: 'jane-doe', name: 'Jane' })),
    )
    expect(markup).toContain('/p/jane-doe')
    expect(markup).toContain('Share on X')
    expect(markup).toContain('Share on Telegram')
    expect(markup).toContain('Share on WhatsApp')
    expect(markup).toContain('<svg')
    expect(markup).toContain('rel="noopener noreferrer"')
  })
})

describe('AccountKindBadge', () => {
  it.each([['demo', 'Demo'], ['live', 'Live'], ['prop', 'Prop'], ['unknown', 'Unknown']] as const)('labels %s', (kind, label) => {
    expect(renderToStaticMarkup(createElement(AccountKindBadge, { kind }))).toContain(label)
  })
})
