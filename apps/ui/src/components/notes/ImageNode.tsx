import {
  $applyNodeReplacement,
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { mergeRegister } from "@lexical/utils";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import { createContext, useContext, useEffect, type JSX } from "react";

import { cn } from "@/lib/utils";

import { resolveNoteImageUrl } from "./notes-api";

export const NotesImageContext = createContext<{ wsUrl: string }>({ wsUrl: "" });

export type SerializedImageNode = Spread<
  {
    altText: string;
    src: string;
  },
  SerializedLexicalNode
>;

export class ImageNode extends DecoratorNode<JSX.Element> {
  __altText: string;
  __src: string;

  static getType(): string {
    return "notes-image";
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(node.__src, node.__altText, node.__key);
  }

  static importJSON(serializedNode: SerializedImageNode): ImageNode {
    return $createImageNode({
      altText: serializedNode.altText,
      src: serializedNode.src,
    }).updateFromJSON(serializedNode);
  }

  constructor(src: string, altText = "", key?: NodeKey) {
    super(key);
    this.__altText = altText;
    this.__src = src;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement("span");
    element.className = "notes-lexical-image-node";
    return element;
  }

  updateDOM(): false {
    return false;
  }

  exportJSON(): SerializedImageNode {
    return {
      ...super.exportJSON(),
      altText: this.getAltText(),
      src: this.getSrc(),
      type: "notes-image",
      version: 1,
    };
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedImageNode>): this {
    return super
      .updateFromJSON(serializedNode)
      .setAltText(serializedNode.altText)
      .setSrc(serializedNode.src);
  }

  decorate(_editor: LexicalEditor): JSX.Element {
    return <NotesImage altText={this.__altText} nodeKey={this.__key} src={this.__src} />;
  }

  getAltText(): string {
    return this.getLatest().__altText;
  }

  getSrc(): string {
    return this.getLatest().__src;
  }

  getTextContent(): string {
    return `![${this.getAltText()}](${this.getSrc()})`;
  }

  isInline(): true {
    return true;
  }

  isKeyboardSelectable(): true {
    return true;
  }

  setAltText(altText: string): this {
    const writable = this.getWritable();
    writable.__altText = altText;
    return writable;
  }

  setSrc(src: string): this {
    const writable = this.getWritable();
    writable.__src = src;
    return writable;
  }
}

export function $createImageNode({ altText, src }: { altText?: string; src: string }): ImageNode {
  return $applyNodeReplacement(new ImageNode(src, altText ?? ""));
}

export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode;
}

function NotesImage({ altText, nodeKey, src }: { altText: string; nodeKey: NodeKey; src: string }) {
  const [editor] = useLexicalComposerContext();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const { wsUrl } = useContext(NotesImageContext);

  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          CLICK_COMMAND,
          (event) => {
            const element = editor.getElementByKey(nodeKey);
            if (!(event.target instanceof Node) || !element?.contains(event.target)) {
              return false;
            }

            if (!event.shiftKey) {
              clearSelection();
            }

            setSelected(!isSelected);
            return true;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          KEY_BACKSPACE_COMMAND,
          () => {
            if (!isSelected || !$isNodeSelection($getSelection())) {
              return false;
            }

            const node = $getNodeByKey(nodeKey);
            if ($isImageNode(node)) {
              node.remove();
              return true;
            }

            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          KEY_DELETE_COMMAND,
          () => {
            if (!isSelected || !$isNodeSelection($getSelection())) {
              return false;
            }

            const node = $getNodeByKey(nodeKey);
            if ($isImageNode(node)) {
              node.remove();
              return true;
            }

            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
      ),
    [clearSelection, editor, isSelected, nodeKey, setSelected],
  );

  return (
    <span
      className={cn("notes-lexical-image", isSelected && "notes-lexical-image-selected")}
      contentEditable={false}
    >
      <img alt={altText} draggable={false} src={resolveNoteImageUrl(wsUrl, src)} />
    </span>
  );
}
