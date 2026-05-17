// Barrel for the Voice v1 schema. Re-exported from `@openclaw/protocol`
// via `src/index.ts`; downstream apps import from the package root, not
// from this file.

export {
  VOICE_SCHEMA_VERSION,
  voiceTopics,
  type VoiceFormat,
  type VoiceFrame,
  type VoiceOpts,
  type VoiceSession,
  type VoiceSignal,
  type VoiceSignalType,
  type VoiceTranscript,
} from './types';

export {
  VoiceFormatSchema,
  VoiceFrameSchema,
  VoiceOptsSchema,
  VoiceSignalSchema,
  VoiceSignalTypeSchema,
  VoiceTranscriptSchema,
} from './schemas';
