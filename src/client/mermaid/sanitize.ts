const STRIP_ELEMENTS = new Set([
  'foreignobject',
  'script',
  'img',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'input',
  'button',
  'form',
  'link',
  'meta',
  'base',
])

export function sanitizeSvg(svg: string): string {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return ''
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  } catch {
    return ''
  }
  if (doc.querySelector('parsererror') !== null) return ''
  if (doc.documentElement === null || doc.documentElement.localName !== 'svg') return ''
  doc.querySelectorAll('*').forEach((node) => {
    if (STRIP_ELEMENTS.has(node.localName.toLowerCase())) {
      node.remove()
      return
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name
      const normalized = name.toLowerCase()
      if (normalized.startsWith('@') || normalized.startsWith('on')) {
        node.removeAttribute(name)
        continue
      }
      if (normalized === 'href' || normalized === 'xlink:href') {
        node.removeAttribute(name)
      }
    }
  })
  return new XMLSerializer().serializeToString(doc.documentElement)
}