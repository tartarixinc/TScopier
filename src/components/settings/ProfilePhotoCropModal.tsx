import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '../ui/Button'
import {
  PROFILE_PHOTO_VIEWPORT,
  profilePhotoCoverScale,
  profilePhotoCropFrame,
  clampProfilePhotoPan,
  renderCroppedProfilePhoto,
} from '../../lib/profilePhotoCrop'

export function ProfilePhotoCropModal({
  file,
  saving,
  title,
  zoomLabel,
  cancelLabel,
  saveLabel,
  onClose,
  onSave,
  onError,
}: {
  file: File | null
  saving: boolean
  title: string
  zoomLabel: string
  cancelLabel: string
  saveLabel: string
  onClose: () => void
  onSave: (file: File) => void
  onError: () => void
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [cropping, setCropping] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null)

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      setImageSize(null)
      setZoom(1)
      setPan({ x: 0, y: 0 })
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setImageSize(null)
    setPreviewUrl(null)

    void (async () => {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
        const maxEdge = 1600
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(bitmap.width * scale))
        canvas.height = Math.max(1, Math.round(bitmap.height * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('crop_failed')
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        bitmap.close()
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
        if (!blob) throw new Error('crop_failed')
        objectUrl = URL.createObjectURL(blob)
      } catch {
        objectUrl = URL.createObjectURL(file)
      }
      if (cancelled) {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        return
      }
      setPreviewUrl(objectUrl)
    })()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file])

  useEffect(() => {
    if (!file) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving && !cropping) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cropping, file, onClose, saving])

  if (!file || typeof document === 'undefined') return null

  const viewport = PROFILE_PHOTO_VIEWPORT
  const scale = imageSize
    ? profilePhotoCoverScale(imageSize.width, imageSize.height, viewport) * zoom
    : 1
  const displayW = imageSize ? imageSize.width * scale : viewport
  const displayH = imageSize ? imageSize.height * scale : viewport
  const panX = clampProfilePhotoPan(pan.x, displayW, viewport)
  const panY = clampProfilePhotoPan(pan.y, displayH, viewport)
  const left = (viewport - displayW) / 2 + panX
  const top = (viewport - displayH) / 2 + panY
  const busy = saving || cropping

  const saveCrop = async () => {
    const image = imageRef.current
    if (!image || !imageSize || busy) return
    setCropping(true)
    try {
      const frame = profilePhotoCropFrame({
        imageWidth: imageSize.width,
        imageHeight: imageSize.height,
        viewport,
        zoom,
        panX,
        panY,
      })
      const cropped = await renderCroppedProfilePhoto(image, frame)
      onSave(cropped)
    } catch {
      onError()
    } finally {
      setCropping(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      onClick={() => { if (!busy) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-photo-crop-title"
        className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="profile-photo-crop-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={cancelLabel}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 flex justify-center">
          <div
            className="relative touch-none overflow-hidden rounded-xl bg-neutral-900"
            style={{ width: viewport, height: viewport }}
            onPointerDown={event => {
              if (!imageSize || busy) return
              event.currentTarget.setPointerCapture(event.pointerId)
              dragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                panX,
                panY,
              }
            }}
            onPointerMove={event => {
              const drag = dragRef.current
              if (!drag || drag.pointerId !== event.pointerId) return
              setPan({
                x: drag.panX + (event.clientX - drag.startX),
                y: drag.panY + (event.clientY - drag.startY),
              })
            }}
            onPointerUp={event => {
              if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
            }}
            onPointerCancel={() => { dragRef.current = null }}
          >
            {previewUrl ? (
              <img
                ref={imageRef}
                src={previewUrl}
                alt=""
                draggable={false}
                className="absolute max-w-none select-none"
                style={{ width: displayW, height: displayH, left, top }}
                onLoad={event => {
                  const img = event.currentTarget
                  setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
                }}
              />
            ) : null}
            <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_999px_rgba(0,0,0,0.55)]" />
          </div>
        </div>

        <label className="mt-4 block">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{zoomLabel}</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            disabled={!imageSize || busy}
            aria-label={zoomLabel}
            onChange={event => setZoom(Number(event.target.value))}
            className="mt-1.5 w-full accent-teal-600"
          />
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button type="button" onClick={() => { void saveCrop() }} loading={busy} disabled={!imageSize}>
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
