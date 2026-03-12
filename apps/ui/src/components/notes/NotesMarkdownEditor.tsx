import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { CodeNode } from '@lexical/code'
import { LinkNode } from '@lexical/link'
import { TRANSFORMERS, $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown'
import { ListItemNode, ListNode } from '@lexical/list'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import { useMemo } from 'react'

const editorTheme = {
  paragraph: 'mb-3 leading-7 text-foreground last:mb-0',
  heading: {
    h1: 'mb-4 mt-8 text-3xl font-semibold tracking-tight text-foreground first:mt-0',
    h2: 'mb-3 mt-8 text-2xl font-semibold tracking-tight text-foreground first:mt-0',
    h3: 'mb-2 mt-6 text-xl font-semibold tracking-tight text-foreground first:mt-0',
    h4: 'mb-2 mt-5 text-lg font-semibold tracking-tight text-foreground first:mt-0',
    h5: 'mb-2 mt-4 text-base font-semibold tracking-tight text-foreground first:mt-0',
    h6: 'mb-2 mt-4 text-sm font-semibold tracking-tight text-muted-foreground first:mt-0',
  },
  list: {
    ul: 'mb-3 ml-6 list-disc space-y-1.5',
    ol: 'mb-3 ml-6 list-decimal space-y-1.5',
    listitem: 'leading-7',
    nested: {
      listitem: 'mt-1',
    },
  },
  quote: 'mb-3 border-l-2 border-border pl-4 italic text-muted-foreground',
  code: 'mb-3 block rounded-lg border border-border/80 bg-muted/50 px-3 py-3 font-mono text-[13px] leading-6 text-foreground',
  link: 'text-primary underline decoration-primary/35 underline-offset-4',
  text: {
    bold: 'font-semibold',
    italic: 'italic',
    code: 'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em]',
  },
}

const editorNodes = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode]

interface NotesMarkdownEditorProps {
  editorId: string
  markdown: string
  onChange: (markdown: string) => void
  placeholder?: string
}

export function NotesMarkdownEditor({
  editorId,
  markdown,
  onChange,
  placeholder = 'Start typing. Markdown shortcuts render as you go.',
}: NotesMarkdownEditorProps) {
  const initialConfig = useMemo(
    () => ({
      namespace: `middleman-notes-${editorId}`,
      theme: editorTheme,
      nodes: editorNodes,
      onError(error: Error) {
        throw error
      },
      editorState() {
        if (!markdown.trim()) {
          return
        }

        $convertFromMarkdownString(markdown, TRANSFORMERS)
      },
    }),
    [editorId, markdown],
  )

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative flex min-h-0 flex-1 bg-background">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="Note editor"
              className="min-h-full flex-1 overflow-y-auto px-5 py-5 text-[15px] outline-none md:px-8 md:py-7"
              spellCheck
            />
          }
          placeholder={
            <div className="pointer-events-none absolute left-5 top-5 text-sm text-muted-foreground/50 md:left-8 md:top-7">
              {placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <LinkPlugin />
      <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
      <OnChangePlugin
        ignoreSelectionChange
        onChange={(editorState) => {
          editorState.read(() => {
            onChange($convertToMarkdownString(TRANSFORMERS))
          })
        }}
      />
    </LexicalComposer>
  )
}
