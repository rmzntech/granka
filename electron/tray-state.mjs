// Tray state shared by main (icon rendering) and ipc (busy/unread events).
// Kept separate so ipc.mjs does not import main.mjs (circular import broke
// the Electron UI tests: registerIpc ran twice).
let trayBusy = false;
let unreadNotifications = 0;
let listener = null;

export function setTrayListener(fn) {
  listener = fn;
}

function notify() {
  try { listener?.(); } catch {}
}

export function setTrayBusy(value) {
  trayBusy = Boolean(value);
  notify();
}

export function bumpUnread() {
  unreadNotifications += 1;
  notify();
}

export function resetUnread() {
  unreadNotifications = 0;
  notify();
}

export function getTrayState() {
  return { trayBusy, unreadNotifications };
}
