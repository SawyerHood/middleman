import { CodeNode } from '@lexical/code'
import { LinkNode } from '@lexical/link'
import {
  type ElementTransformer,
  CHECK_LIST,
  HEADING,
  MULTILINE_ELEMENT_TRANSFORMERS,
  ORDERED_LIST,
  QUOTE,
  TEXT_FORMAT_TRANSFORMERS,
  TEXT_MATCH_TRANSFORMERS,
  UNORDERED_LIST,
} from '@lexical/markdown'
import { ListItemNode, ListNode } from '@lexical/list'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import { $createParagraphNode } from 'lexical'

import { $createImageNode, $isImageNode, formatImageMarkdown, ImageNode } from './ImageNode'

const IMAGE_MARKDOWN_REGEXP = /^!\[([^\]]*)\]\((.+)\)$/

const IMAGE: ElementTransformer = {
  dependencies: [ImageNode],
  export: (node) => {
    if (!$isImageNode(node)) {
      return null
    }

    return formatImageMarkdown(node.getAltText(), node.getSrc())
  },
  regExp: IMAGE_MARKDOWN_REGEXP,
  replace: (parentNode, _children, match, isImport) => {
    const altText = match[1] ?? ''
    const src = match[2]?.trim() ?? ''
    if (!src) {
      return false
    }

    const imageNode = $createImageNode({ altText, src })
    parentNode.replace(imageNode)

    if (isImport) {
      return
    }

    if (imageNode.getNextSibling() !== null) {
      imageNode.selectNext()
      return
    }

    const trailingParagraph = $createParagraphNode()
    imageNode.insertAfter(trailingParagraph)
    trailingParagraph.select()
  },
  type: 'element',
}

export const NOTES_EDITOR_NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  CodeNode,
  ImageNode,
]

// Lexical's built-in TRANSFORMERS omit CHECK_LIST, so it has to run before unordered lists.
export const NOTES_MARKDOWN_TRANSFORMERS = [
  HEADING,
  QUOTE,
  IMAGE,
  CHECK_LIST,
  UNORDERED_LIST,
  ORDERED_LIST,
  ...MULTILINE_ELEMENT_TRANSFORMERS,
  ...TEXT_FORMAT_TRANSFORMERS,
  ...TEXT_MATCH_TRANSFORMERS,
]
