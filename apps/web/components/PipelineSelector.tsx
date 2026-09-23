'use client'

import { useState } from 'react'
import {
  ArrowRightIcon,
  CheckIcon,
  FileTextIcon,
  ImageIcon,
  MusicIcon,
  SparklesIcon,
  VideoIcon,
  Volume2Icon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export interface PipelineNode {
  id: string
  nameKey: string
  icon: React.ReactNode
  descriptionKey: string
}

export interface Pipeline {
  id: string
  nameKey: string
  descriptionKey: string
  nodes: PipelineNode[]
}

const PIPELINES: Pipeline[] = [
  {
    id: 'standard',
    nameKey: 'pipeline.standard',
    descriptionKey: 'pipeline.standard.desc',
    nodes: [
      { id: 'source', nameKey: 'stepper.step.source', icon: <FileTextIcon className="size-4" />, descriptionKey: 'pipeline.node.source.desc' },
      { id: 'script', nameKey: 'stepper.step.script', icon: <FileTextIcon className="size-4" />, descriptionKey: 'pipeline.node.script.desc' },
      { id: 'assets', nameKey: 'stepper.step.assets', icon: <ImageIcon className="size-4" />, descriptionKey: 'pipeline.node.assets.desc' },
      { id: 'storyboards', nameKey: 'stepper.step.storyboards', icon: <SparklesIcon className="size-4" />, descriptionKey: 'pipeline.node.storyboards.desc' },
      { id: 'media', nameKey: 'stepper.step.media', icon: <VideoIcon className="size-4" />, descriptionKey: 'pipeline.node.media.desc' },
      { id: 'composition', nameKey: 'stepper.step.composition', icon: <VideoIcon className="size-4" />, descriptionKey: 'pipeline.node.composition.desc' },
      { id: 'delivery', nameKey: 'stepper.step.delivery', icon: <CheckIcon className="size-4" />, descriptionKey: 'pipeline.node.delivery.desc' },
    ],
  },
  {
    id: 'quick',
    nameKey: 'pipeline.quick',
    descriptionKey: 'pipeline.quick.desc',
    nodes: [
      { id: 'source', nameKey: 'stepper.step.source', icon: <FileTextIcon className="size-4" />, descriptionKey: 'pipeline.node.source.desc' },
      { id: 'script', nameKey: 'stepper.step.script', icon: <FileTextIcon className="size-4" />, descriptionKey: 'pipeline.node.script.desc' },
      { id: 'storyboards', nameKey: 'stepper.step.storyboards', icon: <SparklesIcon className="size-4" />, descriptionKey: 'pipeline.node.storyboards.desc' },
      { id: 'media', nameKey: 'stepper.step.media', icon: <VideoIcon className="size-4" />, descriptionKey: 'pipeline.node.media.desc' },
      { id: 'composition', nameKey: 'stepper.step.composition', icon: <VideoIcon className="size-4" />, descriptionKey: 'pipeline.node.composition.desc' },
      { id: 'delivery', nameKey: 'stepper.step.delivery', icon: <CheckIcon className="size-4" />, descriptionKey: 'pipeline.node.delivery.desc' },
    ],
  },
  {
    id: 'audio_focused',
    nameKey: 'pipeline.audio_focused',
    descriptionKey: 'pipeline.audio_focused.desc',
    nodes: [
      { id: 'source', nameKey: 'stepper.step.source', icon: <FileTextIcon className="size-4" />, descriptionKey: 'pipeline.node.source.desc' },
      { id: 'script', nameKey: 'stepper.step.script', icon: <FileTextIcon className="size-4" />, descriptionKey: 'pipeline.node.script.desc' },
      { id: 'assets', nameKey: 'stepper.step.assets', icon: <ImageIcon className="size-4" />, descriptionKey: 'pipeline.node.assets.desc' },
      { id: 'storyboards', nameKey: 'stepper.step.storyboards', icon: <SparklesIcon className="size-4" />, descriptionKey: 'pipeline.node.storyboards.desc' },
      { id: 'media', nameKey: 'stepper.step.media', icon: <VideoIcon className="size-4" />, descriptionKey: 'pipeline.node.media.desc' },
      { id: 'audio', nameKey: 'stepper.step.media', icon: <Volume2Icon className="size-4" />, descriptionKey: 'pipeline.node.audio.desc' },
      { id: 'music', nameKey: 'stepper.step.media', icon: <MusicIcon className="size-4" />, descriptionKey: 'pipeline.node.music.desc' },
      { id: 'composition', nameKey: 'stepper.step.composition', icon: <VideoIcon className="size-4" />, descriptionKey: 'pipeline.node.composition.desc' },
      { id: 'delivery', nameKey: 'stepper.step.delivery', icon: <CheckIcon className="size-4" />, descriptionKey: 'pipeline.node.delivery.desc' },
    ],
  },
]

function PipelineVisualization({ pipeline, selected }: { pipeline: Pipeline; selected: boolean }) {
  const { t } = useI18n()

  return (
    <div className="flex flex-wrap items-center gap-1">
      {pipeline.nodes.map((node, index) => (
        <div key={node.id} className="flex items-center">
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
              selected ? 'bg-primary/10 border-primary text-primary' : 'bg-muted/50 border-muted text-muted-foreground',
            )}
            title={t(node.descriptionKey)}
          >
            {node.icon}
            <span>{t(node.nameKey)}</span>
          </div>
          {index < pipeline.nodes.length - 1 && (
            <ArrowRightIcon className="size-3 text-muted-foreground/50 mx-0.5" />
          )}
        </div>
      ))}
    </div>
  )
}

interface PipelineSelectorProps {
  value?: string
  onChange: (pipelineId: string) => void
  disabled?: boolean
}

export function PipelineSelector({ value, onChange, disabled }: PipelineSelectorProps) {
  const { t } = useI18n()
  const [hoveredPipeline, setHoveredPipeline] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {PIPELINES.map((pipeline) => {
          const isSelected = value === pipeline.id
          const isHovered = hoveredPipeline === pipeline.id
          return (
            <Card
              key={pipeline.id}
              className={cn(
                'cursor-pointer transition-all duration-200',
                isSelected && 'ring-2 ring-primary',
                !disabled && 'hover:border-primary/50 hover:shadow-md',
                disabled && 'opacity-50 cursor-not-allowed',
              )}
              onClick={() => !disabled && onChange(pipeline.id)}
              onMouseEnter={() => setHoveredPipeline(pipeline.id)}
              onMouseLeave={() => setHoveredPipeline(null)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">{t(pipeline.nameKey)}</CardTitle>
                    <CardDescription className="mt-1 text-xs">{t(pipeline.descriptionKey)}</CardDescription>
                  </div>
                  {isSelected && (
                    <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <CheckIcon className="size-3" />
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <PipelineVisualization pipeline={pipeline} selected={isSelected || isHovered} />
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

interface PipelineDisplayProps {
  pipelineId?: string
  currentStage?: string
}

export function PipelineDisplay({ pipelineId, currentStage }: PipelineDisplayProps) {
  const { t } = useI18n()

  if (!pipelineId) return null

  const pipeline = PIPELINES.find((p) => p.id === pipelineId)
  if (!pipeline) return null

  const currentIndex = pipeline.nodes.findIndex((n) => n.id === currentStage)

  return (
    <div className="rounded-lg border bg-card p-4">
      <h4 className="text-sm font-medium mb-3">{t(pipeline.nameKey)}</h4>
      <div className="flex flex-wrap items-center gap-1">
        {pipeline.nodes.map((node, index) => {
          const isCompleted = currentIndex > index
          const isCurrent = currentIndex === index
          return (
            <div key={node.id} className="flex items-center">
              <div
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                  isCurrent && 'bg-primary text-primary-foreground border-primary',
                  isCompleted && 'bg-primary/20 text-primary border-primary/50',
                  !isCurrent && !isCompleted && 'bg-muted/50 border-muted text-muted-foreground',
                )}
                title={t(node.descriptionKey)}
              >
                {node.icon}
                <span>{t(node.nameKey)}</span>
              </div>
              {index < pipeline.nodes.length - 1 && (
                <ArrowRightIcon
                  className={cn(
                    'size-3 mx-0.5',
                    isCompleted ? 'text-primary' : 'text-muted-foreground/50',
                  )}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
