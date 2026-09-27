'use client'

import { useEffect } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react'

interface ArtifactLightboxProps {
  src: string
  alt: string
  onClose(): void
  /** 同组翻页（同一素材的 v1/v2/v3…）：提供时出现左右箭头与 ←/→ 键。 */
  onPrev?(): void
  onNext?(): void
  /** 底部小注（如「v2 · 关师傅」）；不传不渲染。 */
  caption?: string
}

/**
 * Fullscreen viewer for image artifacts. The blob URL already carries the
 * full-resolution bytes, so this displays the real result at viewport size.
 * Click the backdrop, press Escape, or use the close button to dismiss;
 * with prev/next supplied, ←/→ flip through sibling versions instead of
 * open-close-open — the real motion when comparing takes.
 */
export function ArtifactLightbox({ src, alt, onClose, onPrev, onNext, caption }: ArtifactLightboxProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft' && onPrev) {
        event.preventDefault()
        onPrev()
      }
      if (event.key === 'ArrowRight' && onNext) {
        event.preventDefault()
        onNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext])

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="close"
        onClick={onClose}
        className="bg-muted text-foreground absolute top-4 right-4 rounded-full p-2 shadow hover:opacity-80"
      >
        <XIcon className="size-5" />
      </button>
      {onPrev && (
        <button
          type="button"
          aria-label="previous"
          onClick={event => {
            event.stopPropagation()
            onPrev()
          }}
          className="bg-muted text-foreground absolute left-4 rounded-full p-2 shadow hover:opacity-80"
        >
          <ChevronLeftIcon className="size-5" />
        </button>
      )}
      {onNext && (
        <button
          type="button"
          aria-label="next"
          onClick={event => {
            event.stopPropagation()
            onNext()
          }}
          className="bg-muted text-foreground absolute right-4 rounded-full p-2 shadow hover:opacity-80"
        >
          <ChevronRightIcon className="size-5" />
        </button>
      )}
      {/* Previews are blob URLs from the API origin, so next/image cannot optimize them. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onClick={event => event.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />
      {caption && (
        <span
          onClick={event => event.stopPropagation()}
          className="bg-background/75 text-muted-foreground absolute bottom-4 rounded px-2 py-0.5 text-xs backdrop-blur-sm"
        >
          {caption}
        </span>
      )}
    </div>
  )
}
