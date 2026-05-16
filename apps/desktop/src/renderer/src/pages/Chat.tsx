// Main chat surface.
//
// Per P05B step 4:
//   - Top bar shows the active agent pill + a thread selector (single
//     thread placeholder for v1).
//   - Middle: scrollable `<MessageList>`.
//   - Bottom: `<MessageInput>` with Enter-to-send.

import { MessageInput } from '../components/MessageInput';
import { MessageList } from '../components/MessageList';
import { useGateway } from '../hooks/useGateway';

function statusLabel(status: ReturnType<typeof useGateway>['status']): string {
  switch (status) {
    case 'open':
      return 'connected';
    case 'connecting':
      return 'connecting…';
    case 'closed':
      return 'disconnected';
    case 'error':
      return 'error';
    case 'idle':
    default:
      return 'idle';
  }
}

export function Chat(): JSX.Element {
  const gateway = useGateway();
  const activeAgent =
    gateway.agents.find((a) => a.id === gateway.activeAgent) ?? gateway.agents[0] ?? null;

  return (
    <section className="oc-chat" aria-label="chat">
      <header className="oc-chat-header">
        <div className="oc-agent-pill" aria-label="active agent">
          <span className="oc-agent-pill__label">Agent</span>{' '}
          <strong>{activeAgent?.name ?? 'No agent'}</strong>
          {activeAgent?.id ? <code className="oc-agent-pill__id">{activeAgent.id}</code> : null}
        </div>
        <label className="oc-thread-selector">
          Thread:&nbsp;
          <select aria-label="thread" disabled value={gateway.activeThread}>
            <option value={gateway.activeThread}>{gateway.activeThread}</option>
          </select>
        </label>
        <span
          className={`oc-status oc-status--${gateway.status}`}
          aria-label={`gateway status: ${statusLabel(gateway.status)}`}
        >
          {statusLabel(gateway.status)}
        </span>
      </header>

      <div className="oc-chat-body">
        <MessageList messages={gateway.messages} />
      </div>

      {gateway.lastError ? (
        <p className="oc-chat-error" role="status">
          {gateway.lastError}
        </p>
      ) : null}

      <footer className="oc-chat-footer">
        <MessageInput
          onSubmit={gateway.postMessage}
          disabled={gateway.status !== 'open'}
          placeholder={
            gateway.status === 'open'
              ? 'Type a message — Enter to send, Shift-Enter for newline'
              : `Cannot send while ${statusLabel(gateway.status)}`
          }
        />
      </footer>
    </section>
  );
}
