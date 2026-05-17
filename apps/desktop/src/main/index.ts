// Electron main process for the OpenClaw desktop shell.
//
// P02B opened a hidden BrowserWindow + tray (Show / Quit) and a single-
// instance lock. P03B booted the pairing controller: it loads or creates
// the Ed25519 signing key, opens a fastify HTTP server on
// `127.0.0.1:18789`, and wires up IPC handlers + the macOS pairing
// notification. P04B opens the same port to the LAN (gated by
// `settings.lan_enabled`), advertises `_openclaw._tcp.local.` via
// `bonjour-service`, attaches an authenticated WebSocket transport on
// `/ws`, and bridges incoming frames to an in-process stub gateway.
//
// macOS-only behaviors (`Tray`, `app.dock.hide`, `Notification` actions)
// are guarded with `process.platform === "darwin"` so Linux dev/CI can
// still boot the build without a tray icon asset or a dock to hide.

import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage } from 'electron';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';

// Imported only to prove the `@openclaw/protocol` workspace link resolves in
// the main process. The real wiring lands in P04B (transport). Reference it
// as a type so tree-shaking drops it at runtime.
import type { Agent } from '@openclaw/protocol';
import { buildPairingController, PairingController } from './pair/controller';
import { openKeystore } from './pair/keystore';
import { buildRuntimeUrl, DEFAULT_PORT } from './pair/server';
import { openSelfToken, type SelfToken } from './pair/self-token';
import { SettingsStore } from './settings';
import { createBonjourPublisher, type BonjourPublisher } from './transport/bonjour';
import { createRouter, type Router } from './transport/router';
import { attachWsServer, type WsTransport } from './transport/wsServer';
import { attachStubGateway, type StubGateway } from './gateway/__fixtures__/stub';
import {
  attachClawgUiUnsupportedSurfaces,
  type ClawgUiUnsupportedAttachment,
} from './gateway/clawg-ui-unsupported';
import { openClawgUiIdentityStore, type ClawgUiIdentityHandle } from './clawg-ui/identity';
import { registerCopilotRuntime } from './copilot/runtime';
import { createVoiceRouter, type VoiceRouter } from './voice/router';
import { loadWrtcDeps } from './voice/peer';
import { createPushDeviceRegistry } from './push/devices';
import { createPushClient, type PushClient } from './push/expoClient';
import { attachPushDispatcher, type PushDispatcher } from './push/dispatch';
import { IPC } from '../preload/ipc-channels';

const IS_MAC = process.platform === 'darwin';
const PORT = Number.parseInt(process.env['OPENCLAW_DESKTOP_PORT'] ?? '', 10) || DEFAULT_PORT;
const APP_VERSION = app.getVersion();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let pairing: PairingController | null = null;
let bonjour: BonjourPublisher | null = null;
let wsTransport: WsTransport | null = null;
let stubGateway: StubGateway | null = null;
// P11A: clawg-ui-mode plumbing. The legacy `openClawBridge` slot was
// removed when `attachOpenClawBridge` stopped being called (the bridge
// is `@deprecated`; final removal lands in P11D).
let clawgUiUnsupported: ClawgUiUnsupportedAttachment | null = null;
let clawgUiIdentities: ClawgUiIdentityHandle | null = null;
let router: Router | null = null;
let voiceRouter: VoiceRouter | null = null;
let settings: SettingsStore | null = null;
let lanEnabled = true;
let selfToken: SelfToken | null = null;
let pushClient: PushClient | null = null;
let pushDispatcher: PushDispatcher | null = null;

// Keep the placeholder import live for typecheck without polluting runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _agentTypeProbe: Agent | undefined = undefined;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    show: false, // v1: only shown via tray click.
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // electron-vite injects ELECTRON_RENDERER_URL in dev; in prod we load the
  // built renderer's index.html from disk.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.on('close', (event) => {
    // Closing the window only hides it; the tray icon stays. `before-quit`
    // flips this so Quit from the tray menu actually exits.
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

let isQuitting = false;

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function showWindowOnRoute(route: string): void {
  if (!mainWindow) {
    mainWindow = createMainWindow();
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(IPC.NAVIGATE, route);
}

function buildTrayMenu(): Electron.Menu {
  const lanLabel = `LAN: ${lanEnabled ? 'enabled' : 'disabled'}`;
  const bonjourLabel = `Bonjour: ${bonjour?.state === 'advertising' ? 'advertising' : 'idle'}`;
  return Menu.buildFromTemplate([
    { label: 'Show', click: () => showWindowOnRoute('/chat') },
    { label: 'Chat', click: () => showWindowOnRoute('/chat') },
    { label: 'Agents…', click: () => showWindowOnRoute('/agents') },
    { label: 'Paired devices…', click: () => showWindowOnRoute('/devices') },
    { label: 'Settings…', click: () => showWindowOnRoute('/settings') },
    { type: 'separator' },
    { label: lanLabel, enabled: false },
    { label: bonjourLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray(): void {
  if (!IS_MAC) {
    // Tray is macOS-only for P02B. Other platforms get a normal window on
    // launch so the shell is still usable in dev.
    if (!mainWindow) {
      mainWindow = createMainWindow();
    }
    mainWindow.show();
    return;
  }

  // `resources/trayTemplate.png` is a placeholder. Real iconography is a
  // P09B (release) concern. nativeImage tolerates a missing file by
  // returning an empty image; Electron still renders a clickable region.
  const iconPath = join(__dirname, '../../resources/trayTemplate.png');
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    image.setTemplateImage(true);
  }

  tray = new Tray(image);
  tray.setToolTip('OpenClaw');
  tray.setContextMenu(buildTrayMenu());
  // Per P05B step 7: a plain tray click opens the window directly into
  // the Chat route (rather than just toggling visibility against the
  // current route). The context menu still has explicit entries for
  // Pairing / Devices / Settings if the user wants those.
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      showWindowOnRoute('/chat');
    }
  });
}

async function bootPairing(): Promise<void> {
  settings = new SettingsStore(app.getPath('userData'));
  const cfg = settings.read();
  lanEnabled = cfg.lan_enabled;

  const host = lanEnabled ? '0.0.0.0' : '127.0.0.1';
  // For `runtime_url` we want a value mobile can actually reach. When LAN
  // is on, the Mac's hostname is what Bonjour also advertises; when LAN
  // is off, loopback is correct (only the local renderer will call it).
  const runtimeHost = lanEnabled ? osHostname() : '127.0.0.1';

  pairing = await buildPairingController({
    userDataDir: app.getPath('userData'),
    version: APP_VERSION,
    ipcMain,
    getWindow: getMainWindow,
    Notification: IS_MAC ? Notification : undefined,
    runtimeUrl: buildRuntimeUrl(runtimeHost, PORT),
  });

  await pairing.server.fastify.listen({ host, port: PORT });

  // ---- WS transport + gateway plumbing ----------------------------------
  // `gateway_mode` selects between two paths:
  //
  //   - `"stub"` (default): the legacy in-process echo gateway provides
  //     chat / canvas / voice locally. The renderer + mobile both speak
  //     through the same fastify-mounted CopilotKit runtime adapter
  //     (P05C, `copilot/runtime.ts`) — the WS server forwards their
  //     frames to the stub.
  //
  //   - `"clawg-ui"` (P11A): real-mode chat skips the in-process
  //     translator and routes directly at the user's running
  //     `openclaw gateway` daemon via the `@contextableai/clawg-ui`
  //     plugin's `POST /v1/clawg-ui` endpoint. The clients (renderer +
  //     mobile) construct the URL themselves; the main process only owns
  //     (a) the persistent per-gateway device-token store and (b) a
  //     small router shim that replies with `unsupportedInRealMode` for
  //     canvas / voice / `agents.setActive` (since clawg-ui is
  //     chat-only). The legacy P10A `OpenClawBridge` is `@deprecated`
  //     and no longer instantiated here — removal lands in P11D.
  //
  // The flip is restart-only; see the Settings page.
  router = createRouter();
  if (cfg.gateway_mode === 'clawg-ui') {
    try {
      const clawgKeystore = await openKeystore(app.getPath('userData'));
      clawgUiIdentities = openClawgUiIdentityStore(clawgKeystore);
      // Surface canvas / voice / agents.setActive failures as structured
      // errors instead of WS timeouts. Mobile + renderer already render
      // `lastError` on the chat surface (Q41).
      clawgUiUnsupported = attachClawgUiUnsupportedSurfaces({ router });
      // Chat itself does NOT route through the local WS+stub in
      // clawg-ui mode — clients hit the daemon's HTTP endpoint
      // directly. The WS server stays mounted for the
      // canvas/voice/setActiveAgent error envelopes above.
      const gatewayHost = process.env['OPENCLAW_GATEWAY_HOST'] ?? '127.0.0.1';
      const gatewayPort = Number.parseInt(process.env['OPENCLAW_GATEWAY_PORT'] ?? '', 10) || 18789;
      const upstreamIdentity = await clawgUiIdentities.read(gatewayHost, gatewayPort);
      // eslint-disable-next-line no-console
      console.log(
        `[openclaw] Real-mode chat will route via clawg-ui at http://${gatewayHost}:${gatewayPort}/v1/clawg-ui (device token: ${upstreamIdentity?.deviceToken ? 'present' : 'absent'}${upstreamIdentity?.pairingCode ? `, pairing pending — code ${upstreamIdentity.pairingCode}` : ''})`,
      );
    } catch (err) {
      // Don't crash the app — fall back to the stub so the renderer
      // surface keeps working and the user can see something's wrong
      // in the Settings UI.
      // eslint-disable-next-line no-console
      console.error(
        '[openclaw] clawg-ui identity store failed to attach; falling back to stub:',
        err,
      );
      clawgUiUnsupported?.detach();
      clawgUiUnsupported = null;
      clawgUiIdentities = null;
      stubGateway = attachStubGateway(router);
    }
  } else {
    stubGateway = attachStubGateway(router);
  }
  wsTransport = attachWsServer({
    fastify: pairing.server.fastify,
    publicKey: pairing.signingKey.publicKey,
    router,
  });

  // ---- Voice router (P07B) ----------------------------------------------
  // Lazily loads `@roamhq/wrtc` so a boot on a host without the native
  // binary (very stripped-down Linux dev containers) doesn't take the
  // app down — chat/canvas still work, voice surfaces a runtime error
  // when the phone tries to open a session.
  try {
    const deps = await loadWrtcDeps();
    voiceRouter = createVoiceRouter({ router, deps });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[openclaw] voice router disabled: failed to load @roamhq/wrtc:', err);
    voiceRouter = null;
  }

  // ---- CopilotKit runtime adapter ---------------------------------------
  // Mounts POST /copilot/runtime/agent/:agentId/run on the same fastify
  // server. This is the live endpoint mobile's CopilotKit client points
  // at via the `runtime_url` returned at pairing time. P04B's URL
  // builder already returns `/copilot/runtime`, so registering the
  // route here makes the contract live.
  registerCopilotRuntime({
    fastify: pairing.server.fastify,
    publicKey: pairing.signingKey.publicKey,
    router,
  });

  // ---- Self-token for the renderer chat surface (P05B) ------------------
  // The renderer authenticates against `/ws` + `/copilot/runtime` with a
  // local-only token tied to `device_id: "self"`. We mint (or reload)
  // once at startup and persist it in the same keystore that holds the
  // signing key. Mounting the IPC handler happens below — see
  // `IPC.SYSTEM_GET_SELF_TOKEN`.
  try {
    selfToken = await openSelfToken({
      userDataDir: app.getPath('userData'),
      privateKey: pairing.signingKey.privateKey,
      publicKey: pairing.signingKey.publicKey,
      gatewayId: pairing.gatewayId,
    });
  } catch (err) {
    // Don't take the app down. The renderer's chat surface won't work
    // until the next restart, but pairing + WS still serve real phones.
    // eslint-disable-next-line no-console
    console.error('[openclaw] failed to mint self-token:', err);
    selfToken = null;
  }

  // ---- Push notification dispatcher (P08B) ------------------------------
  // Subscribes to gateway events that warrant nudging the user and fans
  // them out to every paired device with a registered Expo push token.
  // The `expo-server-sdk` import is lazy inside `createPushClient`, so a
  // failure to load (offline / packaging issue) downgrades the path to a
  // no-op rather than taking the app down.
  try {
    pushClient = await createPushClient({
      accessToken: process.env['EXPO_ACCESS_TOKEN'],
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[openclaw] push client unavailable; notifications disabled:', err);
    pushClient = null;
  }
  pushDispatcher = attachPushDispatcher({
    router,
    registry: createPushDeviceRegistry(pairing.deviceStore),
    pushClient,
  });

  // ---- Bonjour ----------------------------------------------------------
  if (lanEnabled) {
    bonjour = createBonjourPublisher({
      gatewayId: pairing.gatewayId,
      version: APP_VERSION,
      port: PORT,
    });
    bonjour.start();
    if (bonjour.state === 'error') {
      // Don't crash the app; log + leave the WS server up. The tray menu
      // will show "Bonjour: idle" so the user can see something's off.
      // eslint-disable-next-line no-console
      console.warn('[openclaw] Bonjour publish failed:', bonjour.lastError);
    }
  }

  refreshTrayMenu();
}

async function teardownTransport(): Promise<void> {
  try {
    pushDispatcher?.detach();
  } catch {
    // ignore
  }
  pushDispatcher = null;
  pushClient = null;
  try {
    await voiceRouter?.close();
  } catch {
    // ignore
  }
  voiceRouter = null;
  try {
    stubGateway?.detach();
  } catch {
    // ignore
  }
  stubGateway = null;
  try {
    clawgUiUnsupported?.detach();
  } catch {
    // ignore
  }
  clawgUiUnsupported = null;
  clawgUiIdentities = null;
  try {
    await wsTransport?.close();
  } catch {
    // ignore
  }
  wsTransport = null;
  try {
    await bonjour?.stop();
  } catch {
    // ignore
  }
  bonjour = null;
  router = null;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      mainWindow = createMainWindow();
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', () => {
    void (async (): Promise<void> => {
      await teardownTransport();
      await pairing?.close();
    })();
  });

  // On macOS the app stays alive in the menu bar with no windows; on other
  // platforms quitting all windows quits the app, matching default UX.
  app.on('window-all-closed', () => {
    if (!IS_MAC) {
      app.quit();
    }
  });

  void app.whenReady().then(async () => {
    if (IS_MAC) {
      // Menu-bar-only app: no dock icon.
      app.dock?.hide();
    }
    mainWindow = createMainWindow();
    createTray();
    try {
      await bootPairing();
    } catch (err) {
      // Don't take the whole app down if the port is busy in dev; just
      // log + leave the renderer up. P04B will add a real diagnostic UX.
      // eslint-disable-next-line no-console
      console.error('[openclaw] failed to start pairing server:', err);
    }
  });
}

// Register the settings IPC at module load: the renderer's Settings page
// can read + (eventually) write `lan_enabled` without depending on
// `bootPairing` having succeeded. v1 only exposes the read path; toggling
// at runtime is intentionally out of scope (a restart picks up the new
// value — see open question 24).
ipcMain.handle(IPC.SETTINGS_GET, async () => {
  // Lazy-construct the store if it doesn't exist yet (e.g. in early
  // renderer load before `bootPairing`).
  if (!settings) {
    settings = new SettingsStore(app.getPath('userData'));
  }
  return settings.read();
});

// Per P05B step 8: the renderer fetches its bearer credential + the
// loopback URLs through this IPC. We always return loopback URLs even
// when LAN is on — the self-token must not be exposed over the LAN.
// If `bootPairing` hasn't run yet (or failed), we return null fields so
// the renderer can surface a friendly "starting up…" state.
ipcMain.handle(IPC.SYSTEM_GET_SELF_TOKEN, async () => {
  if (!selfToken) {
    return {
      token: '',
      expires_at: 0,
      ws_url: `ws://127.0.0.1:${PORT}/ws`,
      runtime_url: `http://127.0.0.1:${PORT}/copilot/runtime`,
    };
  }
  return {
    token: selfToken.token,
    expires_at: selfToken.claim.exp,
    ws_url: `ws://127.0.0.1:${PORT}/ws`,
    runtime_url: `http://127.0.0.1:${PORT}/copilot/runtime`,
  };
});
