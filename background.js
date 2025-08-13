const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isHttpLike = (url) => /^https?:\/\//i.test(url);

function unique(arr) {
  return [...new Set(arr)];
}

function getHostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return null;
  }
}

function getOriginFromUrl(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return null;
  }
}

function cookieMatchesHost(cookie, host) {
  if (!host) return false;
  const cDom = cookie.domain.replace(/^\./, "");
  if (!cookie.domain.startsWith(".")) {
    return host === cDom;
  }
  return host === cDom || host.endsWith("." + cDom);
}

async function removeCookiesForHost(host) {
  const all = await chrome.cookies.getAll({});
  const candidates = all.filter((c) => cookieMatchesHost(c, host));

  let removed = 0;
  for (const c of candidates) {
    const cookieUrl =
      (c.secure ? "https://" : "http://") + c.domain.replace(/^\./, "") + (c.path || "/");
    const details = { url: cookieUrl, name: c.name, storeId: c.storeId };
    if (c.partitionKey) details.partitionKey = c.partitionKey;

    try {
      const res = await chrome.cookies.remove(details);
      if (res) removed++;
    } catch (e) {
    }
  }
  return removed;
}

async function removeSiteDataForOrigins(origins, { resetSiteSettings = true, clearHttpCache = false } = {}) {
  const options = {
    origins,
  };

  const dataToRemove = {
    cacheStorage: true,
    indexedDB: true,
    localStorage: true,
    fileSystems: true,
    serviceWorkers: true,
    webSQL: true,
    pluginData: true,
    siteSettings: !!resetSiteSettings
  };

  await chrome.browsingData.remove(options, dataToRemove);

  if (clearHttpCache) {
    await chrome.browsingData.remove({}, { cache: true });
  }
}

async function removeHistoryForHost(host) {
  const items = await new Promise((resolve) =>
    chrome.history.search({ text: host, startTime: 0, maxResults: 100000 }, resolve)
  );

  let removed = 0;
  for (const it of items) {
    try {
      const uHost = getHostFromUrl(it.url);
      if (!uHost) continue;
      if (uHost === host || uHost.endsWith("." + host)) {
        await chrome.history.deleteUrl({ url: it.url });
        removed++;
      }
    } catch (e) {}
  }
  return removed;
}

async function getFrameOrigins(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const urls = frames.map((f) => f.url).filter((u) => isHttpLike(u));
  const origins = urls.map((u) => getOriginFromUrl(u)).filter(Boolean);
  return unique(origins);
}

async function runInPageCleanup(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: "ISOLATED",
    func: async () => {
      const out = {
        localStorageCleared: false,
        sessionStorageCleared: false,
        idbDeletedCount: 0,
        cachesDeletedCount: 0,
        swUnregistered: 0,
        pushUnsubscribed: 0,
        docCookiesCleared: 0,
        errors: []
      };

      try {
        try {
          const raw = document.cookie || "";
          if (raw) {
            const names = raw.split(";").map((s) => s.trim().split("=")[0]);
            const host = location.hostname;
            const parts = host.split(".");
            const domainsToTry = [];
            for (let i = 0; i < parts.length; i++) {
              const tail = parts.slice(i).join(".");
              domainsToTry.push(tail);
              domainsToTry.push("." + tail);
            }
            const pathsToTry = ["/", location.pathname];
            const expire = "expires=Thu, 01 Jan 1970 00:00:00 GMT";

            for (const name of names) {
              for (const d of domainsToTry) {
                for (const p of pathsToTry) {
                  try {
                    document.cookie = `${name}=; ${expire}; path=${p}; domain=${d}; SameSite=Lax`;
                    document.cookie = `${name}=; ${expire}; path=${p}; domain=${d}; Secure; SameSite=None`;
                  } catch (e) {}
                }
              }
              for (const p of pathsToTry) {
                try {
                  document.cookie = `${name}=; ${expire}; path=${p}; SameSite=Lax`;
                  document.cookie = `${name}=; ${expire}; path=${p}; Secure; SameSite=None`;
                } catch (e) {}
              }
            }
            out.docCookiesCleared = names.length;
          }
        } catch (e) {
          out.errors.push("cookie: " + (e && e.message));
        }

        try {
          localStorage.clear();
          out.localStorageCleared = true;
        } catch (e) {
          out.errors.push("localStorage: " + (e && e.message));
        }

        try {
          sessionStorage.clear();
          out.sessionStorageCleared = true;
        } catch (e) {
          out.errors.push("sessionStorage: " + (e && e.message));
        }

        try {
          if (indexedDB.databases) {
            const dbs = await indexedDB.databases();
            if (Array.isArray(dbs)) {
              for (const db of dbs) {
                if (db && db.name) {
                  try {
                    await new Promise((res, rej) => {
                      const req = indexedDB.deleteDatabase(db.name);
                      req.onsuccess = () => res();
                      req.onerror = () => rej(req.error);
                      req.onblocked = () => res();
                    });
                    out.idbDeletedCount++;
                  } catch (e) {
                  }
                }
              }
            }
          } else {
          }
        } catch (e) {
          out.errors.push("IndexedDB: " + (e && e.message));
        }

        try {
          if (self.caches && caches.keys) {
            const keys = await caches.keys();
            for (const k of keys) {
              try {
                const ok = await caches.delete(k);
                if (ok) out.cachesDeletedCount++;
              } catch (e) {}
            }
          }
        } catch (e) {
          out.errors.push("CacheStorage: " + (e && e.message));
        }

        try {
          if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const reg of regs) {
              try {
                try {
                  const sub = await reg.pushManager.getSubscription();
                  if (sub) {
                    try {
                      const ok = await sub.unsubscribe();
                      if (ok) out.pushUnsubscribed++;
                    } catch (e) {}
                  }
                } catch (e) {}
                try {
                  const ok = await reg.unregister();
                  if (ok) out.swUnregistered++;
                } catch (e) {}
              } catch (e) {}
            }
          }
        } catch (e) {
          out.errors.push("ServiceWorker: " + (e && e.message));
        }

        return out;
      } catch (e) {
        return out;
      }
    }
  });

  return result || {};
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "CLEAN_SITE") {
    (async () => {
      const options = msg.options || {};
      const tab = await getActiveTab();
      if (!tab || !tab.url || !isHttpLike(tab.url)) {
        sendResponse({ ok: false, error: "Нет активной http(s) вкладки" });
        return;
      }

      const mainOrigin = getOriginFromUrl(tab.url);
      const mainHost = getHostFromUrl(tab.url);

      let origins = [mainOrigin];
      if (options.includeThirdParty) {
        try {
          const frameOrigins = await getFrameOrigins(tab.id);
          origins = unique(origins.concat(frameOrigins.filter(Boolean)));
        } catch (e) {}
      }

      const hosts = unique(
        origins
          .map((o) => {
            try {
              return new URL(o).hostname;
            } catch (e) {
              return null;
            }
          })
          .filter(Boolean)
      );

      let cookiesRemovedTotal = 0;
      for (const host of hosts) {
        try {
          cookiesRemovedTotal += await removeCookiesForHost(host);
        } catch (e) {}
      }

      try {
        await removeSiteDataForOrigins(origins, {
          resetSiteSettings: true,
          clearHttpCache: !!options.clearHttpCache
        });
      } catch (e) {}

      let pageCleanup = {};
      try {
        pageCleanup = await runInPageCleanup(tab.id);
      } catch (e) {}

      let historyRemoved = 0;
      if (options.removeHistory && mainHost) {
        try {
          historyRemoved = await removeHistoryForHost(mainHost);
        } catch (e) {}
      }

      if (options.reloadAfter) {
        try {
          await sleep(200);
          await chrome.tabs.reload(tab.id, { bypassCache: true });
        } catch (e) {}
      }

      sendResponse({
        ok: true,
        origins,
        hosts,
        cookiesRemovedTotal,
        historyRemoved,
        pageCleanup
      });
    })();

    return true;
});