import { useEffect } from 'react'
import { LiveChatWidget as LiveChatWidgetRoot } from '@livechat/widget-react'

const LIVECHAT_LICENSE = '19765136'

declare global {
  interface Window {
    __lc?: {
      license?: number
      integration_name?: string
      product_name?: string
    }
    LiveChatWidget?: {
      call: (method: string, ...args: unknown[]) => void
    }
  }
}

export type LiveChatVisibility = 'minimized' | 'maximized' | 'hidden'

type LiveChatWidgetProps = {
  visibility: LiveChatVisibility
  onVisibilityChanged?: (visibility: LiveChatVisibility) => void
}

/** LiveChat widget for support and marketing pages. */
export function LiveChatWidget({ visibility, onVisibilityChanged }: LiveChatWidgetProps) {
  useEffect(() => {
    window.__lc = window.__lc ?? {}
    window.__lc.license = Number(LIVECHAT_LICENSE)
    window.__lc.integration_name = 'manual_channels'
    window.__lc.product_name = 'livechat'
  }, [])

  return (
    <LiveChatWidgetRoot
      license={LIVECHAT_LICENSE}
      visibility={visibility}
      onVisibilityChanged={data => {
        if (data.visibility === 'hidden') return
        onVisibilityChanged?.(data.visibility)
      }}
    />
  )
}

export function maximizeLiveChat(): void {
  window.LiveChatWidget?.call('maximize')
}
