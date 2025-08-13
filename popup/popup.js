function isHttpLike(url) {
  return /^https?:\/\//i.test(url);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

(async () => {
  const tab = await getActiveTab();
  const domainEl = document.getElementById("domain");
  if (tab && tab.url && isHttpLike(tab.url)) {
    try {
      const u = new URL(tab.url);
      domainEl.textContent = `Текущий сайт: ${u.hostname}`;
    } catch (e) {
      domainEl.textContent = "Текущий сайт: неизвестно";
    }
  } else {
    domainEl.textContent = "Откройте страницу http(s)";
  }
})();

document.getElementById("run").addEventListener("click", async () => {
  const btn = document.getElementById("run");
  const resEl = document.getElementById("result");

  const includeThirdParty = document.getElementById("includeThirdParty").checked;
  const removeHistory = document.getElementById("removeHistory").checked;
  const reloadAfter = document.getElementById("reloadAfter").checked;
  const clearHttpCache = document.getElementById("clearHttpCache").checked;

  btn.disabled = true;
  resEl.textContent = "Очищаем…";

  const resp = await chrome.runtime.sendMessage({
    type: "CLEAN_SITE",
    options: { includeThirdParty, removeHistory, reloadAfter, clearHttpCache }
  });

  if (!resp || !resp.ok) {
    resEl.textContent = "Ошибка: " + (resp && resp.error ? resp.error : "неизвестно");
    btn.disabled = false;
    return;
  }

  const { origins, hosts, cookiesRemovedTotal, historyRemoved, pageCleanup } = resp;

  const lines = [];
  lines.push(`Готово!`);
  lines.push(`Origins очищено: ${origins.length}`);
  lines.push(`Хостов очищено (cookies): ${hosts.length}`);
  lines.push(`Удалено cookies: ${cookiesRemovedTotal}`);
  lines.push(`Удалено истории (URL): ${historyRemoved || 0}`);
  if (pageCleanup) {
    lines.push(`— localStorage cleared: ${pageCleanup.localStorageCleared ? "да" : "нет"}`);
    lines.push(`— sessionStorage cleared: ${pageCleanup.sessionStorageCleared ? "да" : "нет"}`);
    lines.push(`— IndexedDB deleted: ${pageCleanup.idbDeletedCount}`);
    lines.push(`— CacheStorage deleted: ${pageCleanup.cachesDeletedCount}`);
    lines.push(`— SW unregistered: ${pageCleanup.swUnregistered}`);
    lines.push(`— Push unsubscribed: ${pageCleanup.pushUnsubscribed}`);
    lines.push(`— Doc cookies cleared (на всякий случай): ${pageCleanup.docCookiesCleared}`);
    if (pageCleanup.errors && pageCleanup.errors.length) {
      lines.push(`Ошибки:`);
      pageCleanup.errors.slice(0, 4).forEach((e) => lines.push("• " + e));
    }
  }

  resEl.textContent = lines.join("\n");
  btn.disabled = false;
});