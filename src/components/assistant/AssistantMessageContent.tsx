import type { ReactNode } from 'react'
import clsx from 'clsx'

type Variant = 'user' | 'assistant'

function renderInline(text: string, variant: Variant): ReactNode[] {
  const nodes: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = re.exec(text)) != null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) {
      nodes.push(
        <strong key={key++} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      )
    } else {
      nodes.push(
        <code
          key={key++}
          className={clsx(
            'rounded px-1 py-0.5  text-[0.85em]',
            variant === 'user'
              ? 'bg-white/20 text-white'
              : 'bg-neutral-100 text-teal-800 dark:bg-neutral-800 dark:text-teal-200',
          )}
        >
          {token.slice(1, -1)}
        </code>,
      )
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function isBullet(line: string) {
  return /^[-*•]\s+/.test(line)
}

function isNumbered(line: string) {
  return /^\d+[.)]\s+/.test(line)
}

/** Lightweight formatting for assistant replies (paragraphs, lists, bold, code). */
export function AssistantMessageContent({
  text,
  variant,
}: {
  text: string
  variant: Variant
}) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }

    if (isBullet(line)) {
      const items: string[] = []
      while (i < lines.length && isBullet(lines[i])) {
        items.push(lines[i].replace(/^[-*•]\s+/, ''))
        i += 1
      }
      blocks.push(
        <ul key={key++} className="my-1.5 list-disc space-y-1 ps-4">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, variant)}</li>
          ))}
        </ul>,
      )
      continue
    }

    if (isNumbered(line)) {
      const items: string[] = []
      while (i < lines.length && isNumbered(lines[i])) {
        items.push(lines[i].replace(/^\d+[.)]\s+/, ''))
        i += 1
      }
      blocks.push(
        <ol key={key++} className="my-1.5 list-decimal space-y-1 ps-4">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, variant)}</li>
          ))}
        </ol>,
      )
      continue
    }

    const para: string[] = [line]
    i += 1
    while (i < lines.length && lines[i].trim() && !isBullet(lines[i]) && !isNumbered(lines[i])) {
      para.push(lines[i])
      i += 1
    }
    blocks.push(
      <p key={key++} className={clsx(blocks.length > 0 && 'mt-2')}>
        {para.map((part, idx) => (
          <span key={idx}>
            {idx > 0 ? <br /> : null}
            {renderInline(part, variant)}
          </span>
        ))}
      </p>,
    )
  }

  if (!blocks.length) {
    return <p className="whitespace-pre-wrap">{text}</p>
  }

  return <div className="space-y-0.5">{blocks}</div>
}
