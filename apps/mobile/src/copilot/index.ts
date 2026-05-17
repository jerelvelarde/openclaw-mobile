// Barrel for the mobile-side CopilotKit runtime client.
//
// Internal-only — the apps/mobile screens import from
// `@/src/copilot` rather than reaching into individual files. Keeps
// the surface area in one place when we re-evaluate the package layout
// (e.g. if we eventually do adopt @copilotkit/react-native).

export {
  CopilotKitProvider,
  useCopilotKit,
  useOptionalCopilotKit,
  useCopilotAction,
  useCopilotReadable,
  DEFAULT_AGENT_ID,
  type CopilotKitContextValue,
  type CopilotKitProviderProps,
} from './CopilotKitProvider';

export {
  createRegistry,
  actionsToAGUITools,
  readablesToAGUIContext,
  paramsToJsonSchema,
  stringifyValue,
  type CopilotAction,
  type CopilotActionParam,
  type CopilotReadable,
  type CopilotRegistry,
} from './registry';

export {
  buildRunUrl,
  buildRuntimeHeaders,
  deriveRuntimeUrlFromHttpBase,
  resolveRuntimeUrl,
  DEFAULT_COPILOT_BASE_PATH,
} from './runtimeUrl';

export {
  runAgent,
  newRunId,
  newUserMessageId,
  type AggregatedAssistantMessage,
  type AggregatedToolCall,
  type RunAgentHandlers,
  type RunAgentOptions,
} from './runAgent';

export {
  parseSseChunk,
  readSseFromResponse,
  type ParsedSseFrame,
  type ParseSseResult,
  type ReadSseOptions,
} from './sse';

export { useChatRun, type ChatTurn, type UseChatRun } from './useChatRun';

export { useSwitchAgentAction, useOpenThreadAction } from './actions';
export {
  useThreadReadable,
  useActiveAgentReadable,
  useLocaleReadable,
  useNetworkReadable,
  useStandardReadables,
  readDeviceLocale,
  type LocaleReadable,
  type NetworkReadable,
  type ThreadReadable,
} from './readables';

export {
  AGUI_EVENT_TYPE,
  type AGUIContextEntry,
  type AGUIEvent,
  type AGUIMessage,
  type AGUITool,
  type AGUIToolCall,
  type RunAgentInput,
} from './types';
