import { PROFILE_PHOTO_MAX_BYTES } from './profilePhoto'

export const PROFILE_PHOTO_VIEWPORT = 280
export const PROFILE_PHOTO_OUTPUT_SIZE = 512

export interface ProfilePhotoCropFrame {
  sourceX: number
  sourceY: number
  sourceSize: number
}

export function profilePhotoCoverScale(imageWidth: number, imageHeight: number, viewport: number): number {
  if (imageWidth <= 0 || imageHeight <= 0 || viewport <= 0) return 1
  return Math.max(viewport / imageWidth, viewport / imageHeight)
}

export function clampProfilePhotoPan(pan: number, displaySize: number, viewport: number): number {
  const max = Math.max(0, (displaySize - viewport) / 2)
  return Math.min(max, Math.max(-max, pan))
}

export function profilePhotoCropFrame(input: {
  imageWidth: number
  imageHeight: number
  viewport: number
  zoom: number
  panX: number
  panY: number
}): ProfilePhotoCropFrame {
  const zoom = Math.min(3, Math.max(1, input.zoom))
  const scale = profilePhotoCoverScale(input.imageWidth, input.imageHeight, input.viewport) * zoom
  const displayW = input.imageWidth * scale
  const displayH = input.imageHeight * scale
  const panX = clampProfilePhotoPan(input.panX, displayW, input.viewport)
  const panY = clampProfilePhotoPan(input.panY, displayH, input.viewport)
  const left = (input.viewport - displayW) / 2 + panX
  const top = (input.viewport - displayH) / 2 + panY
  const sourceSize = input.viewport / scale
  return {
    sourceX: clampSourceOrigin(-left / scale, sourceSize, input.imageWidth),
    sourceY: clampSourceOrigin(-top / scale, sourceSize, input.imageHeight),
    sourceSize,
  }
}

function clampSourceOrigin(origin: number, size: number, imageSize: number): number {
  const max = Math.max(0, imageSize - size)
  return Math.min(max, Math.max(0, origin))
}

export async function renderCroppedProfilePhoto(
  image: CanvasImageSource,
  frame: ProfilePhotoCropFrame,
): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = PROFILE_PHOTO_OUTPUT_SIZE
  canvas.height = PROFILE_PHOTO_OUTPUT_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('crop_failed')
  ctx.drawImage(
    image,
    frame.sourceX,
    frame.sourceY,
    frame.sourceSize,
    frame.sourceSize,
    0,
    0,
    PROFILE_PHOTO_OUTPUT_SIZE,
    PROFILE_PHOTO_OUTPUT_SIZE,
  )

  for (const quality of [0.92, 0.8, 0.65]) {
    const blob = await canvasToJpeg(canvas, quality)
    if (blob && blob.size > 0 && blob.size <= PROFILE_PHOTO_MAX_BYTES) {
      return new File([blob], 'avatar.jpg', { type: 'image/jpeg' })
    }
  }
  throw new Error('too_large')
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality))
}
