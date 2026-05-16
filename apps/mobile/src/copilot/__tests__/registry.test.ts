// Action + readable registry tests.
//
// Exercises insertion order, overwrite-by-id semantics, and the
// serialisation helpers (`actionsToAGUITools`, `readablesToAGUIContext`,
// `stringifyValue`).

import {
  actionsToAGUITools,
  createRegistry,
  paramsToJsonSchema,
  readablesToAGUIContext,
  stringifyValue,
  type CopilotAction,
} from '../registry';

const noopHandler = () => ({ ok: true });

const SWITCH_AGENT: CopilotAction = {
  name: 'switchAgent',
  description: 'change the agent',
  parameters: [{ name: 'agentId', type: 'string', description: 'agent id', required: true }],
  handler: noopHandler,
};

const OPEN_THREAD: CopilotAction = {
  name: 'openThread',
  description: 'open a thread on the device',
  parameters: [{ name: 'id', type: 'string', required: true }],
  handler: noopHandler,
};

describe('registry', () => {
  it('lists actions in insertion order', () => {
    const r = createRegistry();
    r.setAction('a:switch', SWITCH_AGENT);
    r.setAction('a:open', OPEN_THREAD);
    expect(r.listActions().map((a) => a.name)).toEqual(['switchAgent', 'openThread']);
  });

  it('overwrites an action by id without changing slot order', () => {
    const r = createRegistry();
    r.setAction('a:switch', SWITCH_AGENT);
    r.setAction('a:open', OPEN_THREAD);
    r.setAction('a:switch', { ...SWITCH_AGENT, description: 'updated' });
    expect(r.listActions().map((a) => a.description)).toEqual([
      'updated',
      'open a thread on the device',
    ]);
  });

  it('removes actions by id', () => {
    const r = createRegistry();
    r.setAction('a:switch', SWITCH_AGENT);
    r.removeAction('a:switch');
    expect(r.listActions()).toEqual([]);
  });

  it('findAction returns by action.name (not id)', () => {
    const r = createRegistry();
    r.setAction('whatever', SWITCH_AGENT);
    expect(r.findAction('switchAgent')).toBe(SWITCH_AGENT);
    expect(r.findAction('nope')).toBeUndefined();
  });

  it('readables round-trip with insertion order', () => {
    const r = createRegistry();
    r.setReadable('a', { description: 'current thread', value: { id: 't1' } });
    r.setReadable('b', { description: 'active agent', value: 'openclaw.default' });
    expect(r.listReadables().map((r) => r.description)).toEqual(['current thread', 'active agent']);
  });
});

describe('actionsToAGUITools', () => {
  it('emits a JSON-schema-shaped parameters block', () => {
    const out = actionsToAGUITools([SWITCH_AGENT]);
    expect(out).toEqual([
      {
        name: 'switchAgent',
        description: 'change the agent',
        parameters: {
          type: 'object',
          properties: { agentId: { type: 'string', description: 'agent id' } },
          required: ['agentId'],
        },
      },
    ]);
  });
});

describe('paramsToJsonSchema', () => {
  it('treats `required: false` (or absent) as not required', () => {
    expect(
      paramsToJsonSchema([
        { name: 'a', type: 'string' },
        { name: 'b', type: 'number', required: false },
        { name: 'c', type: 'boolean', required: true },
      ]),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' } },
      required: ['c'],
    });
  });
});

describe('readablesToAGUIContext', () => {
  it('stringifies object values with JSON pretty-print', () => {
    const out = readablesToAGUIContext([
      { description: 'current thread', value: { id: 't1', title: 'hi' } },
    ]);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!.value);
    expect(parsed).toEqual({ id: 't1', title: 'hi' });
  });

  it('passes through string values verbatim', () => {
    const out = readablesToAGUIContext([{ description: 'note', value: 'hello' }]);
    expect(out[0]!.value).toBe('hello');
  });
});

describe('stringifyValue', () => {
  it('returns empty string for null/undefined', () => {
    expect(stringifyValue(null)).toBe('');
    expect(stringifyValue(undefined)).toBe('');
  });
  it('handles circular structures via String() fallback', () => {
    const a: { self?: unknown } = {};
    a.self = a;
    expect(stringifyValue(a)).toMatch(/object/);
  });
});
