// ============================================================
// background.js — service worker (Manifest V3)
//
// Контекстное меню «Отключить звук на…» с подпунктами-интервалами.
// По клику вкладка глушится (muted), а по истечении таймера звук
// включается обратно автоматически.
//
// Надёжность таймеров:
//  - интервалы >= 30 сек  -> chrome.alarms (переживают сон SW и браузера);
//  - интервалы  < 30 сек  -> setTimeout (chrome.alarms не работает
//    короче 30 секунд), SW держится активным за счёт обновления плашки;
//  - при каждом запуске SW незавершённые таймеры восстанавливаются
//    из chrome.storage.local, просроченные — сразу выключают звук.
// ============================================================

const PARENT_ID = "mute-parent";
const BUILTIN_DURATIONS = [10, 15, 30, 60, 120, 180, 300]; // секунды
const CUSTOM_KEY = "customDurations"; // chrome.storage.local: [секунды]
const MUTE_PREFIX = "mute:";          // chrome.storage.local: mute:<tabId> = expiresAt (мс)
const ALARM_PREFIX = "unmute-";
const ALARM_MIN_MS = 30000;           // минимальный интервал chrome.alarms
const BADGE_COLOR = "#C5221F";

// Где показывать меню:
//  - "page" — правый клик на самой странице;
//  - ContextType.TAB ("tab") — правый клик по вкладке на панели
//    вкладок. Поддерживается с Chrome 150 (раньше значение
//    "tab" в API существовало, но фактически не работало); на старых версиях
//    константа не определена, и filter(Boolean) просто убирает её —
//    меню останется только на странице, без ошибок.
// При желании можно добавить "link", "video", "audio", "frame".
const MENU_CONTEXTS = [
  "page",
  chrome.contextMenus.ContextType?.TAB,
].filter(Boolean);

const pendingTimeouts = new Map(); // tabId -> id setTimeout (для интервалов < 30 c)
let badgeIntervalId = null;        // цикл обновления плашки (раз в секунду)
let menuBuildChain = Promise.resolve(); // сериализация пересборок меню

/* ---------------- Вспомогательные функции ---------------- */

function formatDuration(sec) {
  if (sec < 60) return `${sec} сек`;
  if (sec % 3600 === 0) return `${sec / 3600} ч`;
  if (sec % 60 === 0) return `${sec / 60} мин`;
  const m = sec / 60;
  const num = Number.isInteger(m)
    ? String(m)
    : m.toFixed(2).replace(/\.?0+$/, "").replace(".", ",");
  return `${num} мин`;
}

function menuItemId(sec) {
  return `mute-${sec}`;
}

function parseMenuItemId(id) {
  const m = /^mute-(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : null;
}

function muteKey(tabId) {
  return `${MUTE_PREFIX}${tabId}`;
}

function alarmName(tabId) {
  return `${ALARM_PREFIX}${tabId}`;
}

// Обёртки с callback, чтобы гасить chrome.runtime.lastError
// (contextMenus и alarms не везде возвращают промисы).
function contextMenusRemoveAll() {
  return new Promise((resolve) =>
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      resolve();
    })
  );
}

function contextMenusCreate(props) {
  return new Promise((resolve) =>
    chrome.contextMenus.create(props, () => {
      void chrome.runtime.lastError;
      resolve();
    })
  );
}

function alarmsCreate(name, alarmInfo) {
  return new Promise((resolve) =>
    chrome.alarms.create(name, alarmInfo, () => {
      void chrome.runtime.lastError;
      resolve();
    })
  );
}

function alarmsClear(name) {
  return new Promise((resolve) =>
    chrome.alarms.clear(name, () => {
      void chrome.runtime.lastError;
      resolve();
    })
  );
}

/* ---------------- Контекстное меню ---------------- */

async function buildMenus() {
  await contextMenusRemoveAll();

  await contextMenusCreate({
    id: PARENT_ID,
    title: "Отключить звук на…",
    contexts: MENU_CONTEXTS,
  });

  const stored = await chrome.storage.local.get(CUSTOM_KEY);
  const custom = Array.isArray(stored[CUSTOM_KEY]) ? stored[CUSTOM_KEY] : [];
  const all = [...new Set([...BUILTIN_DURATIONS, ...custom])]
    .filter((s) => Number.isFinite(s) && s > 0)
    .sort((a, b) => a - b);

  for (const sec of all) {
    await contextMenusCreate({
      id: menuItemId(sec),
      parentId: PARENT_ID,
      title: formatDuration(sec),
      contexts: MENU_CONTEXTS,
    });
  }
}

function scheduleBuildMenus() {
  menuBuildChain = menuBuildChain
    .then(buildMenus)
    .catch((err) => console.error("Не удалось обновить контекстное меню:", err));
  return menuBuildChain;
}

chrome.runtime.onInstalled.addListener(scheduleBuildMenus);
chrome.runtime.onStartup.addListener(scheduleBuildMenus);
scheduleBuildMenus(); // самовосстановление меню при каждом запуске SW

// Изменение своих интервалов в настройках -> перестроить меню.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CUSTOM_KEY]) scheduleBuildMenus();
});

/* ---------------- Хранилище таймеров ---------------- */

// { [tabId]: expiresAt } — по одному ключу на вкладку, чтобы
// параллельные операции не затирали записи друг друга.
async function listMutes() {
  const all = await chrome.storage.local.get(null);
  const mutes = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(MUTE_PREFIX)) continue;
    const tabId = Number(key.slice(MUTE_PREFIX.length));
    if (Number.isFinite(tabId)) mutes[tabId] = value;
  }
  return mutes;
}

async function getExpiry(tabId) {
  const key = muteKey(tabId);
  const stored = await chrome.storage.local.get(key);
  return stored[key];
}

async function setExpiry(tabId, expiresAt) {
  if (expiresAt === undefined) {
    await chrome.storage.local.remove(muteKey(tabId));
  } else {
    await chrome.storage.local.set({ [muteKey(tabId)]: expiresAt });
  }
}

/* ---------------- Таймеры ---------------- */

function clearPending(tabId) {
  const timeoutId = pendingTimeouts.get(tabId);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
    pendingTimeouts.delete(tabId);
  }
  alarmsClear(alarmName(tabId));
}

function armTimer(tabId, expiresAt) {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    unmuteTab(tabId);
    return;
  }
  if (remaining >= ALARM_MIN_MS) {
    // Надёжный путь: будильник переживёт перезапуск service worker.
    alarmsCreate(alarmName(tabId), { when: expiresAt });
  } else {
    // chrome.alarms не срабатывает короче 30 секунд — setTimeout.
    pendingTimeouts.set(
      tabId,
      setTimeout(() => {
        pendingTimeouts.delete(tabId);
        unmuteTab(tabId);
      }, remaining)
    );
  }
}

async function muteTab(tabId, seconds) {
  const expiresAt = Date.now() + seconds * 1000;
  clearPending(tabId); // повторный клик просто перезапускает таймер
  try {
    await chrome.tabs.update(tabId, { muted: true });
  } catch (err) {
    await setExpiry(tabId, undefined); // вкладка уже закрыта
    return;
  }
  await setExpiry(tabId, expiresAt);
  armTimer(tabId, expiresAt);
  ensureBadgeLoop();
  refreshBadge(tabId);
}

async function unmuteTab(tabId) {
  clearPending(tabId);
  await setExpiry(tabId, undefined);
  try {
    await chrome.tabs.update(tabId, { muted: false });
  } catch (err) {
    // Вкладка уже закрыта — не страшно.
  }
  chrome.action.setBadgeText({ tabId, text: "" });
  refreshBadgeLoopState();
}

/* ---------------- Обработчики событий ---------------- */

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const seconds = parseMenuItemId(info.menuItemId);
  if (seconds == null) return;
  if (!tab || typeof tab.id !== "number" || tab.id < 0) return;
  muteTab(tab.id, seconds);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(ALARM_PREFIX.length));
  if (Number.isFinite(tabId)) unmuteTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPending(tabId);
  setExpiry(tabId, undefined);
});

// Пользователь сам включил звук раньше времени — отменяем наш таймер.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.mutedInfo && changeInfo.mutedInfo.muted === false) {
    getExpiry(tabId).then((expiry) => {
      if (expiry !== undefined) unmuteTab(tabId);
    });
  }
});

/* ---------------- Плашка с обратным отсчётом ---------------- */

function badgeText(msLeft) {
  const totalSec = Math.ceil(msLeft / 1000);
  if (totalSec < 60) return String(totalSec);
  const m = Math.floor(totalSec / 60);
  return `${m}:${String(totalSec % 60).padStart(2, "0")}`;
}

function refreshBadge(tabId) {
  getExpiry(tabId).then((expiry) => {
    if (expiry === undefined) return;
    const left = expiry - Date.now();
    chrome.action.setBadgeText({ tabId, text: left > 0 ? badgeText(left) : "" });
  });
}

function ensureBadgeLoop() {
  if (badgeIntervalId === null) {
    // Обновление плашки раз в секунду заодно не даёт service worker
    // заснуть, пока таймер активен (важно для интервалов < 30 c).
    badgeIntervalId = setInterval(tickBadges, 1000);
  }
}

function refreshBadgeLoopState() {
  listMutes().then((mutes) => {
    if (badgeIntervalId !== null && Object.keys(mutes).length === 0) {
      clearInterval(badgeIntervalId);
      badgeIntervalId = null;
    }
  });
}

function tickBadges() {
  listMutes().then((mutes) => {
    const now = Date.now();
    const ids = Object.keys(mutes);
    if (ids.length === 0) {
      refreshBadgeLoopState();
      return;
    }
    for (const idStr of ids) {
      const tabId = Number(idStr);
      const left = mutes[idStr] - now;
      if (left <= 0) {
        unmuteTab(tabId); // страховка, если будильник не дошёл
      } else {
        chrome.action.setBadgeText({ tabId, text: badgeText(left) });
      }
    }
  });
}

void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });

/* ---------------- Восстановление таймеров при запуске SW ---------------- */

(async () => {
  try {
    const mutes = await listMutes();
    let alive = 0;
    for (const [idStr, expiry] of Object.entries(mutes)) {
      const tabId = Number(idStr);
      try {
        await chrome.tabs.get(tabId);
      } catch (err) {
        await setExpiry(tabId, undefined); // вкладка больше не существует
        continue;
      }
      if (expiry <= Date.now()) {
        unmuteTab(tabId); // SW не успел доснуть до срабатывания
      } else {
        alive++;
        armTimer(tabId, expiry); // перевзводим будильник/timeout
      }
    }
    if (alive > 0) ensureBadgeLoop();
  } catch (err) {
    console.error("Не удалось восстановить таймеры:", err);
  }
})();
