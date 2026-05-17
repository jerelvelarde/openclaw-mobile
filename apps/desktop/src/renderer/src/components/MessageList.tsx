// Scrollable list of user + assistant message bubbles, with inline
// tool-call inspectors below each assistant message.
//
// Per P05B step 5. Pure render — all state lives in `useGateway`.

import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../hooks/useGateway';
import { CanvasRenderer } from '../canvas/CanvasRenderer';
import { ToolCallView } from './ToolCallView';

interface MessageListProps {
  messages: ChatMessage[];
}

function MessageBubble({ message }: { message: ChatMessage }): JSX.Element {
  const isUser = message.role === 'user';
  // Canvas placeholder messages render the renderer inline instead of
  // a chat bubble. The wrapping <li> still carries the message-row
  // styles so the conversation flow stays consistent.
  if (message.surfaceId) {
    return (
      <li className="oc-message oc-message--assistant oc-message--canvas">
        <div className="oc-canvas-wrap">
          <CanvasRenderer surfaceId={message.surfaceId} />
        </div>
      </li>
    );
  }
  return (
    <li
      className={`oc-message oc-message--${message.role}`}
      data-streaming={message.streaming ? 'true' : 'false'}
    >
      <div className={`oc-bubble oc-bubble--${isUser ? 'user' : 'agent'}`}>
        <p>{message.content || (message.streaming ? '…' : '')}</p>
      </div>
      {!isUser && message.toolCalls?.length ? (
        <div className="oc-tool-calls" aria-label="tool calls">
          {message.toolCalls.map((tc) => (
            <ToolCallView key={tc.toolCallId} toolCall={tc} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function MessageList({ messages }: MessageListProps): JSX.Element {
  const endRef = useRef<HTMLDivElement | null>(null);

  // Pin scroll to the bottom when new messages arrive. The renderer
  // owns a fixed-height container, so this is a single scrollIntoView.
  // We guard with a typeof check because jsdom doesn't implement
  // `scrollIntoView` on Element prototypes.
  useEffect(() => {
    if (typeof endRef.current?.scrollIntoView === 'function') {
      endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <ol className="oc-message-list" aria-label="conversation">
        <li className="oc-message-empty">
          No messages yet. Say hello to your agent — try <code>hi</code> or{' '}
          <code>open the canvas</code>.
        </li>
      </ol>
    );
  }

  return (
    <ol className="oc-message-list" aria-label="conversation">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      <li className="oc-message-anchor" aria-hidden="true">
        <div ref={endRef} />
      </li>
    </ol>
  );
}
