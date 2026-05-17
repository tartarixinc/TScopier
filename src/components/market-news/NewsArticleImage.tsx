import { useState } from 'react'
import { Newspaper } from 'lucide-react'
import clsx from 'clsx'
import { resolveNewsImageUrl } from '../../lib/resolveNewsImage'

interface NewsArticleImageProps {
  image: string
  alt: string
  className?: string
  iconClassName?: string
}

export function NewsArticleImage({ image, alt, className, iconClassName }: NewsArticleImageProps) {
  const [failed, setFailed] = useState(false)
  const src = resolveNewsImageUrl({ image })
  const showImage = src.length > 0 && !failed

  return (
    <div
      className={clsx(
        'relative overflow-hidden bg-neutral-100 dark:bg-neutral-800',
        className,
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-teal-50 to-neutral-100 dark:from-teal-950/40 dark:to-neutral-900">
          <Newspaper className={clsx('text-teal-600/50 dark:text-teal-400/40', iconClassName ?? 'h-10 w-10')} />
        </div>
      )}
    </div>
  )
}
