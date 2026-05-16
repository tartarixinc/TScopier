export function interpolate(
  template: string,
  vars: Record<string, string | number | undefined>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key]
    return v === undefined ? '' : String(v)
  })
}
