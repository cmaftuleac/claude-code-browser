export type {
  ElementAnchor,
  EditJournalEntry,
  ClientMessage,
  ServerMessage,
  SessionInfo,
  SessionMessage,
  SessionMessageBlock,
  DomTreeNode,
  AttachedFile,
  // Multiplexed control-plane envelope + channels
  ControlChannel,
  Envelope,
  HostInfo,
  HostClientMessage,
  HostServerMessage,
  HostRegisterMessage,
  IceServerConfig,
  IceCandidateInit,
  SignalMessage,
  BrowserInputEvent,
  BrowserControlMessage,
  BrowserStateMessage,
  NotifyMessage,
} from './ws-protocol.js';

// Runtime helpers (values, not types).
export { envelope, isEnvelope } from './ws-protocol.js';

export type { DecodedFrame } from './frame.js';
export { FRAME_VERSION, encodeFrame, decodeFrame } from './frame.js';

export type {
  User,
  AuthResult,
  AccountType,
  TesseractClaims,
  ProfilePayload,
  PlanPayload,
} from './auth.js';

export type { PlanId, BillingInterval, PlanInfo } from './plans.js';
export { ANNUAL_DISCOUNT, PLAN_CATALOG, PLAN_IDS, planById, priceFor } from './plans.js';

export type {
  ThemeMode,
  Density,
  PermissionModeSetting,
  EffortSetting,
  WordWrapSetting,
  RenderWhitespaceSetting,
  McpServerSpec,
  EditorSettings,
  AgentSettings,
  AppearanceSettings,
  GeneralSettings,
  Settings,
  SettingsPatch,
} from './settings.js';
export { MODEL_OPTIONS, DEFAULT_SETTINGS, mergeSettings } from './settings.js';

export type { UpdaterEvent } from './updater.js';
