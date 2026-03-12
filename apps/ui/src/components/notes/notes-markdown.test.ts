import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown'
import { $isListItemNode, $isListNode } from '@lexical/list'
import { $getRoot, createEditor } from 'lexical'
import { describe, expect, it } from 'vitest'

import { $isImageNode } from './ImageNode'
import { NOTES_EDITOR_NODES, NOTES_MARKDOWN_TRANSFORMERS } from './notes-markdown'

function createNotesEditor() {
  return createEditor({
    nodes: NOTES_EDITOR_NODES,
  })
}

describe('NOTES_MARKDOWN_TRANSFORMERS', () => {
  it.each([
    ['- [ ] ship checklist fix', false],
    ['- [x] regression covered', true],
  ])('imports %s as a checklist item', (markdown, checked) => {
    const editor = createNotesEditor()

    editor.update(
      () => {
        $convertFromMarkdownString(markdown, NOTES_MARKDOWN_TRANSFORMERS)

        const root = $getRoot()
        const list = root.getFirstChild()
        expect($isListNode(list)).toBe(true)
        if (!$isListNode(list)) {
          return
        }

        expect(list.getListType()).toBe('check')

        const item = list.getFirstChild()
        expect($isListItemNode(item)).toBe(true)
        if (!$isListItemNode(item)) {
          return
        }

        expect(item.getChecked()).toBe(checked)
      },
      { discrete: true },
    )
  })

  it.each([
    '- [ ] ship checklist fix',
    '- [x] regression covered',
  ])('round-trips %s through markdown conversion', (markdown) => {
    const editor = createNotesEditor()
    let exportedMarkdown = ''

    editor.update(
      () => {
        $convertFromMarkdownString(markdown, NOTES_MARKDOWN_TRANSFORMERS)
        exportedMarkdown = $convertToMarkdownString(NOTES_MARKDOWN_TRANSFORMERS)
      },
      { discrete: true },
    )

    expect(exportedMarkdown).toBe(markdown)
  })

  it('imports markdown image syntax as an image node', () => {
    const editor = createNotesEditor()

    editor.update(
      () => {
        $convertFromMarkdownString('![Screenshot](attachments/upload.png)', NOTES_MARKDOWN_TRANSFORMERS)

        const root = $getRoot()
        const image = root.getFirstChild()
        expect($isImageNode(image)).toBe(true)
        if (!$isImageNode(image)) {
          return
        }

        expect(image.getAltText()).toBe('Screenshot')
        expect(image.getSrc()).toBe('attachments/upload.png')
      },
      { discrete: true },
    )
  })

  it('round-trips markdown images through conversion', () => {
    const editor = createNotesEditor()
    let exportedMarkdown = ''

    editor.update(
      () => {
        $convertFromMarkdownString('![Screenshot](https://example.com/image.png)', NOTES_MARKDOWN_TRANSFORMERS)
        exportedMarkdown = $convertToMarkdownString(NOTES_MARKDOWN_TRANSFORMERS)
      },
      { discrete: true },
    )

    expect(exportedMarkdown).toBe('![Screenshot](https://example.com/image.png)')
  })
})
