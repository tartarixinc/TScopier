import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SocialProfileLinks } from './SocialProfileLinks'

describe('SocialProfileLinks', () => {
  it('renders every supported platform with its recognizable brand treatment', () => {
    const markup = renderToStaticMarkup(createElement(SocialProfileLinks, { links: {
      x: 'https://x.com/trader',
      instagram: 'https://instagram.com/trader',
      telegram: 'https://t.me/trader',
      linkedin: 'https://linkedin.com/in/trader',
      youtube: 'https://youtube.com/@trader',
      tiktok: 'https://tiktok.com/@trader',
      facebook: 'https://facebook.com/trader',
    } }))

    expect(markup).toContain('fill-black dark:fill-white')
    expect(markup).toContain('#833AB4')
    expect(markup).toContain('#0A66C2')
    expect(markup).toContain('#FF0000')
    expect(markup).toContain('#25F4EE')
    expect(markup).toContain('#FE2C55')
    expect(markup).toContain('#1877F2')
    expect(markup).toContain('#229ED9')
    expect(markup.match(/target="_blank"/g)).toHaveLength(7)
    expect(markup.match(/rel="noopener noreferrer"/g)).toHaveLength(7)
    expect(markup.match(/referrerPolicy="no-referrer"/g)).toHaveLength(7)
  })

  it('omits an unsafe link instead of rendering a clickable logo', () => {
    const markup = renderToStaticMarkup(createElement(SocialProfileLinks, { links: {
      youtube: 'javascript:alert(1)',
      x: 'https://x.com/trader',
    } }))

    expect(markup).toContain('Open X profile')
    expect(markup).not.toContain('Open YouTube profile')
    expect(markup).not.toContain('javascript:')
  })
})
