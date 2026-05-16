// Text — renders a `TextNode` as a paragraph.
//
// Long runs wrap on whitespace; we don't currently support inline
// formatting (bold/links/etc.). When that lands it'll be a new node
// type, not a markdown-flavoured field on `text`.

import type { TextNode } from '@openclaw/protocol';

interface TextProps {
  node: TextNode;
}

export function Text({ node }: TextProps): JSX.Element {
  return <p className="oc-canvas-text">{node.text}</p>;
}
