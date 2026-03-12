import { DecoratorBlockNode, type SerializedDecoratorBlockNode } from '@lexical/react/LexicalDecoratorBlockNode'
import {
  $applyNodeReplacement,
  type ElementFormatType,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type Spread,
} from 'lexical'
import { createContext, useContext, type JSX } from 'react'

import { resolveNoteImageUrl } from './notes-api'

export type SerializedImageNode = Spread<
  {
    altText: string
    src: string
    type: 'image'
    version: 1
  },
  SerializedDecoratorBlockNode
>

export const NotesImageContext = createContext('')

export class ImageNode extends DecoratorBlockNode {
  __src: string
  __altText: string

  static getType(): string {
    return 'image'
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(node.__src, node.__altText, node.__format, node.__key)
  }

  static importJSON(serializedNode: SerializedImageNode): ImageNode {
    return $createImageNode({
      altText: serializedNode.altText,
      format: serializedNode.format,
      src: serializedNode.src,
    }).updateFromJSON(serializedNode)
  }

  constructor(src: string, altText = '', format?: ElementFormatType, key?: NodeKey) {
    super(format, key)
    this.__src = src
    this.__altText = altText
  }

  exportJSON(): SerializedImageNode {
    return {
      ...super.exportJSON(),
      altText: this.getAltText(),
      src: this.getSrc(),
      type: 'image',
      version: 1,
    }
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedImageNode>): this {
    return super
      .updateFromJSON(serializedNode)
      .setSrc(serializedNode.src)
      .setAltText(serializedNode.altText)
  }

  getTextContent(): string {
    return formatImageMarkdown(this.getAltText(), this.getSrc())
  }

  getSrc(): string {
    return this.getLatest().__src
  }

  getAltText(): string {
    return this.getLatest().__altText
  }

  setSrc(src: string): this {
    const writable = this.getWritable()
    writable.__src = src
    return writable
  }

  setAltText(altText: string): this {
    const writable = this.getWritable()
    writable.__altText = altText
    return writable
  }

  decorate(): JSX.Element {
    return <RenderedImage altText={this.getAltText()} src={this.getSrc()} />
  }
}

export function $createImageNode(options: {
  src: string
  altText?: string
  format?: ElementFormatType
}): ImageNode {
  const { src, altText = '', format } = options
  return $applyNodeReplacement(new ImageNode(src, altText, format))
}

export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode
}

export function formatImageMarkdown(altText: string, src: string): string {
  return `![${escapeMarkdownImageText(altText)}](${src})`
}

function RenderedImage({ altText, src }: { altText: string; src: string }) {
  const wsUrl = useContext(NotesImageContext)
  const resolvedSrc = resolveNoteImageUrl(wsUrl, src)

  return (
    <div className="my-6">
      <img
        alt={altText}
        className="mx-auto block h-auto max-w-full rounded-xl border border-border/60 bg-muted/20 object-contain shadow-sm"
        loading="lazy"
        src={resolvedSrc}
      />
    </div>
  )
}

function escapeMarkdownImageText(value: string): string {
  return value.replace(/]/g, '\\]')
}
