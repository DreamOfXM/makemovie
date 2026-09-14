'use client'

import { useEffect } from 'react'
import { XIcon } from 'lucide-react'

interface ArtifactLightboxProps {
  src: string
  alt: string
  onClose(): void
}

/**
 * Fullscreen viewer for image artifacts. The blob URL already carries the
 * full-resolution bytes, so this displays the real result at viewport size.
 * Click the backdrop, press Escape, or use the close button to dismiss.
 */
export function ArtifactLightbox({ src, alt, onClose }: ArtifactLightboxProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
        className="bg-muted text-foreground absolute right-4 top-4 rounded-full p-2 shadow hover:opacity-80"
      >
        <XIcon className="size-5" />
      </button>
      {/* Previews are blob URLs from the API origin, so next/image cannot optimize them. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onClick={event => event.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />
    </div>
  )
}
