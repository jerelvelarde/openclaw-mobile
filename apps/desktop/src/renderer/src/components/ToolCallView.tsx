// Collapsible inline tool-call inspector.
//
// Per P05B step 5: every tool call surfaced under an assistant message
// renders here. Closed by default — the user clicks to expand and see
// the args + (optional) result JSON.

import { useState } from 'react';
import type { ToolCallView as ToolCallViewModel } from '../hooks/useGateway';

interface ToolCallViewProps {
  toolCall: ToolCallViewModel;
  /** Force the panel open in tests so we can assert on the args panel. */
  defaultOpen?: boolean;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCallView({ toolCall, defaultOpen }: ToolCallViewProps): JSX.Element {
  const [open, setOpen] = useState<boolean>(defaultOpen ?? false);

  return (
    <details
      className="oc-tool-call"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      aria-label={`tool call: ${toolCall.toolName}`}
    >
      <summary>
        <span aria-hidden="true">{'⚙'}</span> <strong>{toolCall.toolName}</strong>
      </summary>
      <div className="oc-tool-call-body">
        <h4>args</h4>
        <pre>{formatJson(toolCall.args)}</pre>
        {toolCall.result !== undefined ? (
          <>
            <h4>result</h4>
            <pre>{formatJson(toolCall.result)}</pre>
          </>
        ) : null}
      </div>
    </details>
  );
}
