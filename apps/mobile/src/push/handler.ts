// Push notification handlers (deep-link routing + foreground policy).
//
// Two responsibilities, kept in the same file so we have one obvious place
// to look when wiring or debugging push UX:
//
//   1. `setupNotificationHandler` — controls how an *incoming* notification
//      is presented while the app is foregrounded. Per the P08A plan, we
//      *don't* show a system banner over the running app; instead we
//      surface a lightweight in-app banner via the `notifyInAppBanner`
//      callback so the user doesn't get an OS banner that obscures the
//      surface they're actively using. The system handler still emits the
//      `addNotificationReceivedListener` event, which the in-app banner
//      hook can consume.
//
//   2. `attachNotificationResponseHandler` — listens for *taps* on a
//      delivered notification and deep-links into the relevant thread.
//      Payload shape is `{ threadId: string }` (set by the desktop in
//      P08B). On a missing/bad payload we no-op so a malformed push from
//      a future server version can't crash the app.
//
// Both surfaces are kept structural (we accept a `NotificationsLike`
// stub instead of importing `expo-notifications` directly) so the unit
// tests can run without the native module.

/**
 * Minimal router contract we depend on. We don't import `Router` from
 * `expo-router` because its `push` signature is a discriminated href type
 * that's awkward to satisfy from a test stub — and we only need the
 * runtime call (which accepts the string URL form). Mirrors what
 * `useOpenThreadAction` does in `src/copilot/actions.ts`.
 */
export interface RouterLike {
  push(href: string): void;
}

/**
 * The structural shape of a notification response we care about. Mirrors
 * `expo-notifications`'s `NotificationResponse`/`NotificationContent` types
 * but narrowed to just the fields we actually read. Keeping it local lets
 * the test runner mock `expo-notifications` without faking the whole type.
 */
export interface NotificationResponseLike {
  notification: {
    request: {
      content: {
        data?: Record<string, unknown> | null;
      };
    };
  };
}

/** Structural payload we expect from the desktop's push send. */
export interface PushPayload {
  /** Thread to open when the user taps the notification. */
  threadId?: unknown;
}

/**
 * Subset of `expo-notifications` we depend on. Matches the shape from
 * `register.ts` for the bits we share, but adds the response + foreground
 * handler hooks the push pipeline needs.
 */
export interface NotificationsHandlerLike {
  setNotificationHandler(
    handler: {
      handleNotification(notification: unknown): Promise<{
        shouldShowBanner: boolean;
        shouldShowList: boolean;
        shouldPlaySound: boolean;
        shouldSetBadge: boolean;
      }>;
    } | null,
  ): void;
  addNotificationReceivedListener(listener: (event: unknown) => void): { remove(): void };
  addNotificationResponseReceivedListener(listener: (event: NotificationResponseLike) => void): {
    remove(): void;
  };
}

/**
 * Lazily load the real `expo-notifications` module. The web path skips
 * this entirely — see the helpers below.
 */
function loadNotifications(): NotificationsHandlerLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-notifications') as NotificationsHandlerLike;
}

/**
 * Convert a (possibly-malformed) notification response payload into a
 * thread route, or `null` when the payload isn't actionable. Exposed so
 * the unit tests can exercise the pure routing logic without mounting
 * `expo-notifications`.
 */
export function payloadToThreadHref(payload: PushPayload | undefined | null): string | null {
  if (!payload || typeof payload.threadId !== 'string' || payload.threadId.length === 0) {
    return null;
  }
  // Expo Router accepts the URL form `/(tabs)/threads/<id>`. Matches the
  // route used by `useOpenThreadAction` in `src/copilot/actions.ts`.
  return `/(tabs)/threads/${encodeURIComponent(payload.threadId)}`;
}

/**
 * Run the routing side effect for a tapped notification. Returns the
 * resolved href (or `null` when the payload was unactionable) so callers
 * can assert on it in tests.
 */
export function handleNotificationResponse(
  response: NotificationResponseLike,
  router: RouterLike,
): string | null {
  const data = response.notification.request.content.data ?? undefined;
  const href = payloadToThreadHref(data as PushPayload);
  if (!href) return null;
  router.push(href);
  return href;
}

/**
 * Options for `attachNotificationResponseHandler`.
 */
export interface AttachResponseHandlerOptions {
  router: RouterLike;
  /** Optional onTap hook — fires after the router navigates. */
  onTap?: (href: string) => void;
  /** Inject the notifications surface. Defaults to real `expo-notifications`. */
  notifications?: NotificationsHandlerLike;
  /**
   * Override the platform — on web we skip the listener entirely and
   * return a no-op unsubscribe.
   */
  isWeb?: boolean;
}

/**
 * Subscribe to notification *taps* and route them. Returns an unsubscribe
 * function so callers can tear the listener down on unmount. On web, returns
 * a no-op unsubscribe immediately.
 */
export function attachNotificationResponseHandler(opts: AttachResponseHandlerOptions): () => void {
  if (opts.isWeb) {
    return () => {};
  }
  const notifications = opts.notifications ?? loadNotifications();
  const sub = notifications.addNotificationResponseReceivedListener((event) => {
    const href = handleNotificationResponse(event, opts.router);
    if (href && opts.onTap) opts.onTap(href);
  });
  return () => sub.remove();
}

/**
 * Options for `setupNotificationHandler`.
 */
export interface SetupNotificationHandlerOptions {
  /**
   * Callback invoked when a notification arrives while the app is in the
   * foreground. The plan calls for an in-app banner instead of the OS
   * system notification — the consumer (e.g. the root layout) provides
   * the banner UI.
   */
  notifyInAppBanner?: (event: unknown) => void;
  /** Inject the notifications surface. Defaults to real `expo-notifications`. */
  notifications?: NotificationsHandlerLike;
  /** Skip everything on web. */
  isWeb?: boolean;
}

/**
 * Configure foreground notification behavior. We don't show a system
 * banner when the app is already on-screen; instead we route the event
 * to `notifyInAppBanner` (if provided). The system list / badge / sound
 * are all suppressed in foreground mode — the user is already looking at
 * the app, the surface that needs their attention is what should change.
 *
 * Returns an unsubscribe that detaches the received-listener and clears
 * the foreground handler. On web, returns a no-op.
 */
export function setupNotificationHandler(opts: SetupNotificationHandlerOptions = {}): () => void {
  if (opts.isWeb) {
    return () => {};
  }
  const notifications = opts.notifications ?? loadNotifications();
  notifications.setNotificationHandler({
    handleNotification: async () => ({
      // Suppress the system banner while the app is foregrounded — the
      // in-app banner will pick up the event via the listener below.
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  const sub = notifications.addNotificationReceivedListener((event) => {
    if (opts.notifyInAppBanner) opts.notifyInAppBanner(event);
  });
  return () => {
    sub.remove();
    notifications.setNotificationHandler(null);
  };
}
