import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { CodeNode } from '@lexical/code'
import { LinkNode } from '@lexical/link'
import { TRANSFORMERS, $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown'
import { ListItemNode, ListNode } from '@lexical/list'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import { memo, useMemo } from 'react'

const editorTheme = {
  paragraph: 'mb-4 leading-[1.72] text-foreground/95 last:mb-0',
  heading: {
    h1: 'mb-6 mt-4 text-[2.3rem] font-bold leading-tight tracking-[-0.04em] text-foreground first:mt-0 md:text-[2.75rem]',
    h2: 'mb-4 mt-12 text-[1.75rem] font-semibold leading-tight tracking-[-0.03em] text-foreground first:mt-0 md:text-[2rem]',
    h3: 'mb-3 mt-10 text-[1.35rem] font-semibold leading-tight tracking-[-0.02em] text-foreground first:mt-0 md:text-[1.55rem]',
    h4: 'mb-3 mt-8 text-lg font-semibold tracking-tight text-foreground first:mt-0 md:text-[1.15rem]',
    h5: 'mb-2 mt-6 text-base font-semibold tracking-tight text-foreground first:mt-0',
    h6: 'mb-2 mt-6 text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground first:mt-0',
  },
  list: {
    ul: 'mb-6 ml-6 list-disc space-y-2',
    ol: 'mb-6 ml-6 list-decimal space-y-2',
    checklist: 'mb-6 ml-0 space-y-2 pl-0',
    listitem: 'leading-[1.72] marker:text-muted-foreground/65',
    listitemChecked:
      "relative list-none pl-9 text-muted-foreground/80 before:absolute before:left-0 before:top-[0.42rem] before:h-5 before:w-5 before:rounded-md before:border before:border-primary/30 before:bg-primary/15 before:content-[''] after:pointer-events-none after:absolute after:left-[0.43rem] after:top-[0.7rem] after:h-2.5 after:w-1.5 after:rotate-45 after:border-b-2 after:border-r-2 after:border-primary after:content-['']",
    listitemUnchecked:
      "relative list-none pl-9 before:absolute before:left-0 before:top-[0.42rem] before:h-5 before:w-5 before:rounded-md before:border before:border-border before:bg-background/80 before:content-['']",
    nested: {
      list: 'mt-2',
      listitem: 'mt-2',
    },
  },
  quote: 'mb-6 border-l border-border pl-4 italic text-muted-foreground',
  code: 'mb-6 block rounded-xl border border-border/70 bg-muted/45 px-4 py-3 font-mono text-[13px] leading-6 text-foreground',
  link: 'text-primary/90 underline decoration-transparent underline-offset-4 transition-colors hover:text-primary hover:decoration-primary/60',
  text: {
    bold: 'font-semibold',
    italic: 'italic',
    code: 'rounded-md bg-muted/70 px-1.5 py-0.5 font-mono text-[0.92em] text-foreground',
  },
}

const editorNodes = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode]

interface NotesMarkdownEditorProps {
  editorId: string
  markdown: string
  onChange: (markdown: string) => void
  placeholder?: string
}

export const NotesMarkdownEditor = memo(function NotesMarkdownEditor({
  editorId,
  markdown,
  onChange,
  placeholder = 'Start writing...',
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
      <div className="relative min-h-0 flex-1 overflow-y-auto bg-background">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="Note editor"
              className="mx-auto block min-h-full w-full max-w-[720px] px-5 py-8 text-[16px] leading-[1.72] text-foreground outline-none md:px-10 md:py-14"
              spellCheck
            />
          }
          placeholder={
            <div className="pointer-events-none absolute inset-x-0 top-8 px-5 text-[16px] leading-[1.72] text-muted-foreground/40 md:top-14 md:px-10">
              <div className="mx-auto max-w-[720px]">{placeholder}</div>
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <CheckListPlugin />
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
})
