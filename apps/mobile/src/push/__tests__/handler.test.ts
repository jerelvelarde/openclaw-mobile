// Tests for the push notification response + foreground handlers.
//
// We assert:
//   - A well-formed payload `{ threadId }` resolves to the expected route.
//   - A missing / malformed payload is a no-op (no router.push, returns null).
//   - The web path attaches no listener and returns a no-op unsubscribe.
//   - `setupNotificationHandler` configures a foreground handler that
//     suppresses the system banner and routes the incoming event into the
//     supplied in-app banner callback.

import {
  attachNotificationResponseHandler,
  handleNotificationResponse,
  payloadToThreadHref,
  setupNotificationHandler,
  type NotificationResponseLike,
  type NotificationsHandlerLike,
} from '../handler';

/** Build a notification response with the given data payload. */
function buildResponse(data: unknown): NotificationResponseLike {
  return {
    notification: {
      request: {
        content: {
          data: data as Record<string, unknown> | null,
        },
      },
    },
  };
}

/** Minimal router stub recording the latest `push` arg. */
function mockRouter(): { push: jest.Mock<void, [string]> } {
  return { push: jest.fn() };
}

/** Build a `NotificationsHandlerLike` stub exposing the registered listeners. */
function buildNotificationsHandlerStub(): NotificationsHandlerLike & {
  _responseListeners: Array<(event: NotificationResponseLike) => void>;
  _receivedListeners: Array<(event: unknown) => void>;
  _foregroundHandler: Parameters<NotificationsHandlerLike['setNotificationHandler']>[0];
  _emitResponse(event: NotificationResponseLike): void;
  _emitReceived(event: unknown): void;
  _responseRemoved: boolean;
  _receivedRemoved: boolean;
} {
  const responseListeners: Array<(event: NotificationResponseLike) => void> = [];
  const receivedListeners: Array<(event: unknown) => void> = [];
  let responseRemoved = false;
  let receivedRemoved = false;
  let foregroundHandler: Parameters<NotificationsHandlerLike['setNotificationHandler']>[0] | null =
    null;
  const stub = {
    setNotificationHandler: jest.fn(
      (handler: Parameters<NotificationsHandlerLike['setNotificationHandler']>[0]) => {
        foregroundHandler = handler;
      },
    ),
    addNotificationReceivedListener: jest.fn((listener: (event: unknown) => void) => {
      receivedListeners.push(listener);
      return {
        remove() {
          receivedRemoved = true;
        },
      };
    }),
    addNotificationResponseReceivedListener: jest.fn(
      (listener: (event: NotificationResponseLike) => void) => {
        responseListeners.push(listener);
        return {
          remove() {
            responseRemoved = true;
          },
        };
      },
    ),
    get _foregroundHandler() {
      return foregroundHandler;
    },
    get _responseRemoved() {
      return responseRemoved;
    },
    get _receivedRemoved() {
      return receivedRemoved;
    },
    _responseListeners: responseListeners,
    _receivedListeners: receivedListeners,
    _emitResponse(event: NotificationResponseLike): void {
      for (const l of responseListeners) l(event);
    },
    _emitReceived(event: unknown): void {
      for (const l of receivedListeners) l(event);
    },
  };
  return stub;
}

describe('payloadToThreadHref', () => {
  it('builds the (tabs)/threads/[id] href from a valid payload', () => {
    expect(payloadToThreadHref({ threadId: 'thread_abc' })).toBe('/(tabs)/threads/thread_abc');
  });

  it('url-encodes thread ids with reserved characters', () => {
    expect(payloadToThreadHref({ threadId: 'thread/with space' })).toBe(
      '/(tabs)/threads/thread%2Fwith%20space',
    );
  });

  it('returns null on a missing or empty threadId', () => {
    expect(payloadToThreadHref(undefined)).toBeNull();
    expect(payloadToThreadHref(null)).toBeNull();
    expect(payloadToThreadHref({})).toBeNull();
    expect(payloadToThreadHref({ threadId: '' })).toBeNull();
    expect(payloadToThreadHref({ threadId: 42 as unknown as string })).toBeNull();
  });
});

describe('handleNotificationResponse', () => {
  it('calls router.push with the expected thread href', () => {
    const router = mockRouter();
    const href = handleNotificationResponse(buildResponse({ threadId: 't1' }), router);
    expect(href).toBe('/(tabs)/threads/t1');
    expect(router.push).toHaveBeenCalledWith('/(tabs)/threads/t1');
  });

  it('does not navigate on a malformed payload', () => {
    const router = mockRouter();
    const href = handleNotificationResponse(buildResponse({ otherField: 'x' }), router);
    expect(href).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('does not navigate when data is null', () => {
    const router = mockRouter();
    const response: NotificationResponseLike = {
      notification: { request: { content: { data: null } } },
    };
    const href = handleNotificationResponse(response, router);
    expect(href).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('attachNotificationResponseHandler', () => {
  it('subscribes via expo-notifications and routes incoming taps', () => {
    const notifications = buildNotificationsHandlerStub();
    const router = mockRouter();
    const onTap = jest.fn();
    const detach = attachNotificationResponseHandler({ router, onTap, notifications });
    expect(notifications.addNotificationResponseReceivedListener).toHaveBeenCalled();

    notifications._emitResponse(buildResponse({ threadId: 't42' }));
    expect(router.push).toHaveBeenCalledWith('/(tabs)/threads/t42');
    expect(onTap).toHaveBeenCalledWith('/(tabs)/threads/t42');

    detach();
    expect(notifications._responseRemoved).toBe(true);
  });

  it('skips the listener entirely on web', () => {
    const notifications = buildNotificationsHandlerStub();
    const router = mockRouter();
    const detach = attachNotificationResponseHandler({ router, isWeb: true, notifications });
    expect(notifications.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
    // Detach is a no-op but must be callable.
    detach();
    expect(notifications._responseRemoved).toBe(false);
  });

  it('does not call onTap when the payload is malformed', () => {
    const notifications = buildNotificationsHandlerStub();
    const router = mockRouter();
    const onTap = jest.fn();
    attachNotificationResponseHandler({ router, onTap, notifications });
    notifications._emitResponse(buildResponse({ threadId: '' }));
    expect(router.push).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });
});

describe('setupNotificationHandler', () => {
  it('suppresses the foreground system banner and surfaces the event in-app', async () => {
    const notifications = buildNotificationsHandlerStub();
    const banner = jest.fn();
    const detach = setupNotificationHandler({ notifyInAppBanner: banner, notifications });

    // The handler should suppress every visual surface so the banner can
    // own the foreground presentation.
    const handler = notifications._foregroundHandler;
    expect(handler).not.toBeNull();
    const behavior = await handler!.handleNotification({});
    expect(behavior).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });

    // The received-listener routes the event into the banner callback.
    notifications._emitReceived({ from: 'test' });
    expect(banner).toHaveBeenCalledWith({ from: 'test' });

    detach();
    expect(notifications._receivedRemoved).toBe(true);
    expect(notifications.setNotificationHandler).toHaveBeenLastCalledWith(null);
  });

  it('is a no-op on web', () => {
    const notifications = buildNotificationsHandlerStub();
    const detach = setupNotificationHandler({ isWeb: true, notifications });
    expect(notifications.setNotificationHandler).not.toHaveBeenCalled();
    expect(notifications.addNotificationReceivedListener).not.toHaveBeenCalled();
    detach();
  });
});
