// ==UserScript==
// @name         LBC Seller-Trust Filter
// @namespace    https://github.com/gushmazuko
// @version      1.5.0
// @description  Hides Leboncoin ads from young, poorly rated or low-review sellers and removes advertisements
// @match        https://www.leboncoin.fr/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const MS_IN_DAY = 86_400_000;
  const MAX_CONCURRENT = 4;

  const CARD_SELECTOR = '[data-qa-id="aditem_container"]';
  const AD_SELECTOR = "#video-listing";

  const MIN_RATING = 4.5;
  const MIN_REVIEWS = 3;

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------
  let monthsThreshold = GM_getValue("monthsThreshold", 6);

  GM_registerMenuCommand("Set age threshold (months)…", () => {
    const input = prompt(
      "Hide sellers registered less than how many months ago?",
      String(monthsThreshold)
    );
    if (input === null) return;
    const next = Math.max(1, Math.min(36, Number(input) || monthsThreshold));
    monthsThreshold = next;
    GM_setValue("monthsThreshold", next);
  });

  // ---------------------------------------------------------------------
  // Concurrency limiter — bounds burst API traffic
  // ---------------------------------------------------------------------
  function createSemaphore(limit) {
    let active = 0;
    const queue = [];

    function next() {
      if (queue.length === 0 || active >= limit) return;
      active++;
      const resolve = queue.shift();
      resolve();
    }

    return {
      acquire() {
        return new Promise(resolve => {
          queue.push(resolve);
          next();
        });
      },
      release() {
        active--;
        next();
      }
    };
  }

  const evalSemaphore = createSemaphore(MAX_CONCURRENT);

  // ---------------------------------------------------------------------
  // Trust engine — network + caching, no DOM
  // ---------------------------------------------------------------------
  function blockedError(url, detail) {
    const err = new Error(`possibly blocked by anti-bot protection — ${url} (${detail})`);
    err.blocked = true;
    return err;
  }

  async function fetchJson(url, init) {
    const res = await fetch(url, { credentials: "include", ...init });
    const contentType = res.headers.get("content-type") || "";
    const looksJson = contentType.includes("json");

    if (!res.ok) {
      if (!looksJson || res.status === 403 || res.status === 429) {
        throw blockedError(url, `HTTP ${res.status}, content-type "${contentType}"`);
      }
      throw new Error(`${url} → HTTP ${res.status}`);
    }
    if (!looksJson) {
      throw blockedError(url, `unexpected content-type "${contentType}" on 200`);
    }
    try {
      return await res.json();
    } catch (err) {
      throw blockedError(url, `JSON parse failed: ${err.message}`);
    }
  }

  // Counts and throttles the loud anti-bot warning so a sustained block doesn't
  // spam the console; ordinary (non-blocked) failures stay a plain console.warn.
  let blockedCount = 0;
  const BLOCKED_LOG_EVERY = 20;

  function logFetchFailure(err) {
    if (err && err.blocked) {
      blockedCount++;
      if (blockedCount === 1 || blockedCount % BLOCKED_LOG_EVERY === 0) {
        console.error(
          `[lbc-trust] possibly blocked by anti-bot protection (${blockedCount} occurrence${blockedCount > 1 ? "s" : ""} this session)`,
          err
        );
      }
    } else {
      console.warn("[lbc-trust]", err);
    }
  }

  // Per-user memoised profile lookup: caching the promise gives in-flight
  // dedupe for free. Failed lookups are evicted so a later retry can
  // succeed instead of being stuck on a cached rejection.
  const userInfoCache = new Map(); // userId -> Promise<object>

  function getUserInfo(userId) {
    if (!userInfoCache.has(userId)) {
      const promise = fetchJson(
        `https://api.leboncoin.fr/api/user-card/v1/${encodeURIComponent(userId)}/infos`
      );
      promise.catch(() => userInfoCache.delete(userId));
      userInfoCache.set(userId, promise);
    }
    return userInfoCache.get(userId);
  }

  function computeAgeOk(registeredAt) {
    const registeredMs = Date.parse(registeredAt);
    if (Number.isNaN(registeredMs)) {
      throw new Error(`unparseable registered_at: ${registeredAt}`);
    }
    return Date.now() - registeredMs >= monthsThreshold * 30.4375 * MS_IN_DAY;
  }

  const verdictCache = new Map(); // userId -> { hide }
  const inFlight = new Map(); // userId -> Promise<{ hide }>

  function evaluateSeller({ userId }) {
    const key = userId;

    if (verdictCache.has(key)) return Promise.resolve(verdictCache.get(key));
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
      await evalSemaphore.acquire();
      try {
        const userInfo = await getUserInfo(userId);
        const ageOk = computeAgeOk(userInfo.registered_at);

        const overallScore = Number(userInfo.feedback?.overall_score);
        const receivedCount = Number(userInfo.feedback?.received_count);

        const rating = Number.isFinite(overallScore)
          ? Math.max(0, Math.min(5, overallScore * 5))
          : null;

        const reviewCount = Number.isFinite(receivedCount)
          ? receivedCount
          : 0;

        const hide =
          !ageOk ||
          reviewCount < MIN_REVIEWS ||
          (rating !== null && rating < MIN_RATING);

        const result = { hide };
        verdictCache.set(key, result);
        return result;
      } catch (err) {
        logFetchFailure(err);
        return { hide: false }; // fail-open — not cached
      } finally {
        evalSemaphore.release();
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, promise);
    return promise;
  }

  // ---------------------------------------------------------------------
  // DOM layer — ad-card discovery and filtering
  // ---------------------------------------------------------------------
  function isSearchPage() {
    return location.pathname.startsWith("/recherche");
  }

  function hideCard(card) {
    if (!card.isConnected) return;

    const item = card.closest('li[class*="styles_adCard"]') || card.closest("li");

    if (item) {
      item.style.display = "none";
      return;
    }

    card.style.display = "none";
  }

  function hideAdvertisement(node) {
    const ad = node.matches?.(AD_SELECTOR)
      ? node
      : node.querySelector?.(AD_SELECTOR);

    if (!ad) return;

    const item = ad.closest("li");

    if (item) {
      item.style.display = "none";
    }
  }

  const seen = new WeakSet();

  function processNode(card) {
    if (!isSearchPage()) return;
    if (seen.has(card)) return;
    seen.add(card);

    const link = card.querySelector("a[href*='/ad/']");
    if (!link) return;
    const listId = link.pathname.split("/").pop();
    if (!/^\d+$/.test(listId)) return;

    fetchJson(`https://api.leboncoin.fr/finder/classified/${listId}`)
      .then(data => {
        const { owner } = data;
        if (!owner?.user_id) return;

        return evaluateSeller({ userId: owner.user_id }).then(
          ({ hide }) => {
            if (hide) hideCard(card);
          }
        );
      })
      .catch(logFetchFailure);
  }

  function processAllAds() {
    document.querySelectorAll(CARD_SELECTOR).forEach(processNode);
    document.querySelectorAll(AD_SELECTOR).forEach(hideAdvertisement);
  }

  processAllAds();

  new MutationObserver(muts => {
    muts.forEach(m => {
      m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;

        if (n.matches?.(CARD_SELECTOR)) processNode(n);
        n.querySelectorAll?.(CARD_SELECTOR).forEach(processNode);

        hideAdvertisement(n);
        n.querySelectorAll?.(AD_SELECTOR).forEach(hideAdvertisement);
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
