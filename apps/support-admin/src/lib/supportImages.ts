import { supabase } from './supabase'

export const SUPPORT_MAX_IMAGES = 3
export const SUPPORT_ATTACHMENTS_BUCKET = 'support-attachments'
export const SUPPORT_ACCEPTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
])

const MAX_DIMENSION = 1280
const JPEG_QUALITY = 0.72
const MAX_DATA_URL_CHARS = 1_200_000

export function isSupportImageType(type: string): boolean {
  return SUPPORT_ACCEPTED_IMAGE_TYPES.has(type.toLowerCase())
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    img.src = url
  })
}

export async function fileToSupportImageDataUrl(file: File): Promise<string> {
  if (!isSupportImageType(file.type)) throw new Error('unsupported_type')
  const img = await loadImageFromFile(file)
  const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height, 1))
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas_unavailable')
  ctx.drawImage(img, 0, 0, w, h)
  let quality = JPEG_QUALITY
  let dataUrl = canvas.toDataURL('image/jpeg', quality)
  while (dataUrl.length > MAX_DATA_URL_CHARS && quality > 0.4) {
    quality -= 0.1
    dataUrl = canvas.toDataURL('image/jpeg', quality)
  }
  if (dataUrl.length > MAX_DATA_URL_CHARS) throw new Error('too_large')
  return dataUrl
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl)
  if (!match) throw new Error('invalid_data_url')
  const mime = match[1]
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export async function uploadAgentSupportImages(params: {
  agentUserId: string
  conversationId: string
  dataUrls: string[]
}): Promise<string[]> {
  const urls: string[] = []
  for (const dataUrl of params.dataUrls.slice(0, SUPPORT_MAX_IMAGES)) {
    const blob = dataUrlToBlob(dataUrl)
    const ext = blob.type.includes('png')
      ? 'png'
      : blob.type.includes('webp')
        ? 'webp'
        : blob.type.includes('gif')
          ? 'gif'
          : 'jpg'
    const path = `${params.agentUserId}/agent/${params.conversationId}/${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage.from(SUPPORT_ATTACHMENTS_BUCKET).upload(path, blob, {
      contentType: blob.type || 'image/jpeg',
      upsert: false,
      cacheControl: '3600',
    })
    if (error) throw new Error(error.message)
    const { data } = supabase.storage.from(SUPPORT_ATTACHMENTS_BUCKET).getPublicUrl(path)
    urls.push(data.publicUrl)
  }
  return urls
}
