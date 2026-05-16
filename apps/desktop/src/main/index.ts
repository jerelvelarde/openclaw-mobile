// Electron main process for the OpenClaw desktop shell.
//
// Scope for P02B: open a hidden BrowserWindow, install a macOS menu-bar tray
// (Show / Quit), and hold a single-instance lock so two copies of the app
// can't fight over the gateway port later. Pairing, transport, supervision,
// and chat all land in P03B+ — none of that lives here yet.
//
// macOS-only behaviors (`Tray`, `app.dock.hide`) are guarded with
// `process.platform === "darwin"` so Linux dev/CI can still boot the build
// without a tray icon asset or a dock to hide.

import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';

// Imported only to prove the `@openclaw/protocol` workspace link resolves in
// the main process. The real wiring lands in P03B (pairing) and P04B
// (transport). Reference it as a type so tree-shaking drops it at runtime.
import type { Agent } from '@openclaw/protocol';

const IS_MAC = process.platform === 'darwin';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

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

  // On macOS the app stays alive in the menu bar with no windows; on other
  // platforms quitting all windows quits the app, matching default UX.
  app.on('window-all-closed', () => {
    if (!IS_MAC) {
      app.quit();
    }
  });

  void app.whenReady().then(() => {
    if (IS_MAC) {
      // Menu-bar-only app: no dock icon.
      app.dock?.hide();
    }
    mainWindow = createMainWindow();
    createTray();
  });
}
