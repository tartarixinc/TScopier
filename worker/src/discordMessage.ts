export type DiscordEmbedText = {
  title?: string | null
  description?: string | null
  fields?: Array<{ name?: string | null; value?: string | null }> | null
}

/** Plain text plus embed title, description, and fields, as one parser input. */
export function flattenDiscordMessage(content: string, embeds: DiscordEmbedText[]): string {
  const parts: string[] = []
  const body = content.trim()
  if (body) parts.push(body)
  for (const embed of embeds) {
    const title = embed.title?.trim()
    const description = embed.description?.trim()
    if (title) parts.push(title)
    if (description) parts.push(description)
    for (const field of embed.fields ?? []) {
      const name = field.name?.trim() ?? ''
      const value = field.value?.trim() ?? ''
      const line = [name, value].filter(Boolean).join('\n')
      if (line) parts.push(line)
    }
  }
  return parts.join('\n').slice(0, 8000)
}
