// Agents picker page. Renders the agents reported by `agents.list` (the
// stub gateway today, the real OpenClaw gateway once it lands) and lets
// the user switch the active one.
//
// Per P05B step 6.

import { useGateway } from '../hooks/useGateway';

export function Agents(): JSX.Element {
  const gateway = useGateway();

  if (gateway.agents.length === 0) {
    return (
      <section aria-label="agents">
        <h2>Agents</h2>
        <p>Waiting for the gateway to report its agents…</p>
        {gateway.lastError ? <p role="status">{gateway.lastError}</p> : null}
      </section>
    );
  }

  return (
    <section aria-label="agents">
      <h2>Agents</h2>
      <p>Tap an agent to make it the target for new messages.</p>
      <ul className="oc-agents-list">
        {gateway.agents.map((agent) => {
          const active = agent.id === gateway.activeAgent;
          return (
            <li key={agent.id}>
              <button
                type="button"
                className={`oc-agent-row ${active ? 'oc-agent-row--active' : ''}`}
                aria-pressed={active}
                onClick={() => gateway.setActiveAgent(agent.id)}
              >
                <strong>{agent.name}</strong>
                <code>{agent.id}</code>
                {agent.description ? <span>{agent.description}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
