import { useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { Link } from 'react-router-dom'
import { providerShareTargets, providerShareUrl, providerSharePath } from '../../lib/providerApplication'
import { Button } from '../ui/Button'

export function ProviderShareCard({
  slug,
  name,
  shareTradeHistory = null,
  manageHref,
}: {
  slug: string
  name: string
  /** false = visitors cannot see performance yet; null/true = no hint. */
  shareTradeHistory?: boolean | null
  /** Where the provider can turn trade-history sharing on. */
  manageHref?: string
}) {
  const [copied, setCopied] = useState(false)
  const url = providerShareUrl(typeof window === 'undefined' ? 'https://app.tscopier.ai' : window.location.origin, slug)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Your public profile link</h3>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
        Share this link anywhere. People can see your profile and follow or copy you after signing in.
      </p>
      {shareTradeHistory === false && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Turn on Share trade history so visitors can see your performance on this link.{' '}
          {manageHref && <Link to={manageHref} className="font-medium underline">Open my profile</Link>}
        </p>
      )}
      <div className="mt-3 flex flex-col gap-4 sm:flex-row">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={url}
              aria-label="Public profile link"
              onFocus={event => event.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
            <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {providerShareTargets(url, name).map(target => (
              <a
                key={target.key}
                href={target.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center rounded-full border border-neutral-200 px-3 py-1 text-xs font-medium text-neutral-800 transition-colors hover:border-green-400 dark:border-neutral-700 dark:text-neutral-200"
              >
                Share on {target.label}
              </a>
            ))}
            <Link
              to={providerSharePath(slug)}
              className="inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:underline dark:text-green-400"
            >
              Preview <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-center rounded-lg bg-white p-2" aria-label="QR code for your public profile link">
          <QRCodeSVG value={url} size={112} marginSize={1} />
        </div>
      </div>
    </div>
  )
}
