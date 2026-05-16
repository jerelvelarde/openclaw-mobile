// Electron main process for the OpenClaw desktop shell.
//
// P02B opened a hidden BrowserWindow + tray (Show / Quit) and a single-
// instance lock. P03B now boots the pairing controller as well: it loads
// or creates the Ed25519 signing key, opens a fastify HTTP server on
// `127.0.0.1:18789` (loopback only — LAN exposure is P04B), and wires
// up IPC handlers + the macOS pairing notification.
//
// macOS-only behaviors (`Tray`, `app.dock.hide`, `Notification` actions)
// are guarded with `process.platform === "darwin"` so Linux dev/CI can
// still boot the build without a tray icon asset or a dock to hide.

import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage } from 'electron';
import { join } from 'node:path';

// Imported only to prove the `@openclaw/protocol` workspace link resolves in
// the main process. The real wiring lands in P04B (transport). Reference it
// as a type so tree-shaking drops it at runtime.
import type { Agent } from '@openclaw/protocol';
import { buildPairingController, PairingController } from './pair/controller';
import { DEFAULT_PORT } from './pair/server';
import { IPC } from '../preload/ipc-channels';

const IS_MAC = process.platform === 'darwin';
const PORT = Number.parseInt(process.env['OPENCLAW_DESKTOP_PORT'] ?? '', 10) || DEFAULT_PORT;
const APP_VERSION = app.getVersion();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let pairing: PairingController | null = null;

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

function toggleMainWindow(): void {
  if (!mainWindow) {
    mainWindow = createMainWindow();
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function showWindowOnRoute(route: string): void {
  if (!mainWindow) {
    mainWindow = createMainWindow();
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(IPC.NAVIGATE, route);
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: toggleMainWindow },
      { label: 'Paired devices…', click: () => showWindowOnRoute('/devices') },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', toggleMainWindow);
}

async function bootPairing(): Promise<void> {
  pairing = await buildPairingController({
    userDataDir: app.getPath('userData'),
    version: APP_VERSION,
    ipcMain,
    getWindow: getMainWindow,
    Notification: IS_MAC ? Notification : undefined,
  });
  // Bind to loopback only — LAN exposure is P04B.
  await pairing.server.fastify.listen({ host: '127.0.0.1', port: PORT });
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
    void pairing?.close();
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
      console.error('[openclaw] failed to start pairing server:', err);
    }
  });
}
