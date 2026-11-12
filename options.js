// ============================================================
// options.js — логика страницы настроек:
// добавление и удаление своих интервалов для контекстного меню.
// ============================================================

const CUSTOM_KEY = "customDurations";
const BUILTIN = [10, 15, 30, 60, 120, 180, 300]; // секунды (дублируются из background.js)
const MAX_SECONDS = 86400; // 24 часа

const form = document.getElementById("add-form");
const valueInput = document.getElementById("value");
const unitSelect = document.getElementById("unit");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("custom-list");
const emptyNote = document.getElementById("empty-note");

let custom = [];

/* ---------------- Утилиты ---------------- */

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

let statusTimer = null;
function showStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
  statusEl.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.hidden = true;
  }, 3000);
}

/* ---------------- Отрисовка списка ---------------- */

function render() {
  listEl.textContent = "";
  for (const sec of [...custom].sort((a, b) => a - b)) {
    const li = document.createElement("li");

    const label = document.createElement("span");
    label.textContent = formatDuration(sec);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "delete";
    del.textContent = "Удалить";
    del.dataset.sec = String(sec);
    del.setAttribute("aria-label", `Удалить интервал ${formatDuration(sec)}`);

    li.append(label, del);
    listEl.append(li);
  }
  emptyNote.hidden = custom.length !== 0;
}

async function load() {
  try {
    const stored = await chrome.storage.local.get(CUSTOM_KEY);
    custom = Array.isArray(stored[CUSTOM_KEY]) ? stored[CUSTOM_KEY] : [];
  } catch (err) {
    custom = [];
  }
  render();
}

/* ---------------- Добавление интервала ---------------- */

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const raw = valueInput.value.trim().replace(",", ".");
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    showStatus("Введите положительное число.", "err");
    return;
  }
  if (unitSelect.value === "sec" && !Number.isInteger(value)) {
    showStatus("Секунды должны быть целым числом. Для долей выберите «мин» (например, 1,5 мин = 90 сек).", "err");
    return;
  }

  const seconds = unitSelect.value === "min" ? Math.round(value * 60) : value;
  if (seconds < 1) {
    showStatus("Слишком маленький интервал — минимум 1 секунда.", "err");
    return;
  }
  if (seconds > MAX_SECONDS) {
    showStatus("Слишком большой интервал — максимум 24 часа.", "err");
    return;
  }
  if (BUILTIN.includes(seconds) || custom.includes(seconds)) {
    showStatus(`Интервал «${formatDuration(seconds)}» уже есть в меню.`, "err");
    return;
  }

  custom.push(seconds);
  custom.sort((a, b) => a - b);
  await chrome.storage.local.set({ [CUSTOM_KEY]: custom });

  valueInput.value = "";
  valueInput.focus();
  render();
  showStatus(`Добавлено: ${formatDuration(seconds)}. Пункт появился в меню.`, "ok");
});

/* ---------------- Удаление интервала ---------------- */

listEl.addEventListener("click", async (event) => {
  const btn = event.target.closest("button.delete");
  if (!btn) return;

  const sec = Number(btn.dataset.sec);
  custom = custom.filter((s) => s !== sec);
  await chrome.storage.local.set({ [CUSTOM_KEY]: custom });

  render();
  showStatus(`Удалено: ${formatDuration(sec)}.`, "ok");
});

/* ---------------- Синхронизация при внешних изменениях ---------------- */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CUSTOM_KEY]) {
    custom = Array.isArray(changes[CUSTOM_KEY].newValue)
      ? changes[CUSTOM_KEY].newValue
      : [];
    render();
  }
});

load();
