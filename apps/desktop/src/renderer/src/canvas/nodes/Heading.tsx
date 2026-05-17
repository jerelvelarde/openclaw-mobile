// Heading — renders a `HeadingNode` as an `<h1>`–`<h6>` per `level`.
//
// `level` defaults to 1 (matches the protocol type). The renderer keeps
// the rest of the node fields out of the DOM; styling is handled by the
// host's CSS (see `styles.css`).

import type { HeadingNode } from '@openclaw/protocol';

interface HeadingProps {
  node: HeadingNode;
}

export function Heading({ node }: HeadingProps): JSX.Element {
  const level = node.level ?? 1;
  const className = 'oc-canvas-heading';
  switch (level) {
    case 1:
      return <h1 className={className}>{node.text}</h1>;
    case 2:
      return <h2 className={className}>{node.text}</h2>;
    case 3:
      return <h3 className={className}>{node.text}</h3>;
    case 4:
      return <h4 className={className}>{node.text}</h4>;
    case 5:
      return <h5 className={className}>{node.text}</h5>;
    case 6:
      return <h6 className={className}>{node.text}</h6>;
    default:
      return <h1 className={className}>{node.text}</h1>;
  }
}
