// Nook service worker (WAVES_10-12.md D65, §4.4, T68, T69). Handwritten, scoped to "/".
//
// Pushes are payload-less: a push only wakes this worker, which fetches the unread
// notifications from Nook with the session cookie and shows them. There is deliberately no
// fetch handler: this worker never sees or caches page or API traffic. Clicking a notification
// opens only same-origin paths rebuilt from ids.

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERIC_TITLE = "You have a new notification in Nook";
const ICON = "/icons/nook-192.png";
const MAX_SHOWN = 5;

// Bell deep links (v0.32): the shapes the server builds (server/access/notices.ts and
// server/calendar/reminders.ts, from server/mail/links.ts), each from ids only. The app's own
// safeNotificationPath checks the same paths against the router.
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SAFE_PATHS = [
  "/notifications", "/inbox", "/inbox/routines", `/inbox/p/${ID}`, `/inbox/history/p/${ID}`,
  "/calendar", `/calendar/event/${ID}`,
  "/notes", `/notes/${ID}`, `/notes/folder/${ID}`, "/files", `/files/${ID}`,
  "/tasks", `/tasks/${ID}`, `/tasks/${ID}/card/${ID}`, `/tasks/views/${ID}`,
  "/collections", `/collections/${ID}`, `/collections/${ID}/row/${ID}`, `/whiteboards/${ID}`,
  "/vault", `/vault/${ID}`, "/chat", `/chat/${ID}`, `/chat/new\\?agent=${ID}`,
  "/settings/(?:security|keys|access|notifications|agents|knowledge)", `/settings/agents/${ID}`, `/settings/knowledge/${ID}`
].map((pattern) => new RegExp(`^${pattern}$`, "i"));

// The push body says what kind of line it is (TODO "Push notifications"); the title is the bell's
// own line, built by the server for this user. Nothing else from the item is shown: no ids, no
// paths, no text the bell does not show (T63, T127, T135).
const KIND_BODIES = { reminder: "Calendar reminder", proposals: "Suggested changes in your Inbox", access: "Sharing and access" };

/** The body under a notification's title: its kind, and "delivered late" as the bell says for a late reminder. */
function bodyFor(item) {
  const kind = typeof item.kind === "string" && Object.prototype.hasOwnProperty.call(KIND_BODIES, item.kind) ? KIND_BODIES[item.kind] : "Notification";
  return item.late === true ? `${kind} · delivered late` : kind;
}

/** The only paths a notification may open: one of the shapes above, lowercased; anything else opens the list. */
function safePath(href) {
  if (typeof href !== "string" || href.length > 200 || !SAFE_PATHS.some((pattern) => pattern.test(href))) return "/notifications";
  return href.toLowerCase();
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

async function showUnread() {
  let items = [];
  try {
    const response = await fetch("/api/notifications?unread=1&limit=5", { credentials: "same-origin", cache: "no-store", redirect: "error" });
    if (response.ok) {
      const body = await response.json();
      if (body && Array.isArray(body.items)) items = body.items;
    }
  } catch {
    // Signed out, offline, or the server is unreachable: fall back to the generic notice.
  }
  const valid = items.filter((item) => item && typeof item.id === "string" && idPattern.test(item.id) && typeof item.title === "string").slice(0, MAX_SHOWN);
  if (!valid.length) {
    await self.registration.showNotification(GENERIC_TITLE, { tag: "nook-reminder", icon: ICON, data: { path: "/notifications" } });
    return;
  }
  await Promise.all(valid.map((item) => self.registration.showNotification(item.title.slice(0, 200), {
    // tag = notification id, so a repeated push never shows the same reminder twice.
    tag: item.id,
    body: bodyFor(item),
    icon: ICON,
    data: { path: safePath(item.href) }
  })));
}

self.addEventListener("push", (event) => {
  event.waitUntil(showUnread());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.path);
  event.waitUntil((async () => {
    const target = new URL(path, self.location.origin);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        await client.focus();
        if ("navigate" in client) await client.navigate(target.href);
        return;
      } catch {
        // The window could not be focused or navigated: open the same safe path instead.
        break;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
