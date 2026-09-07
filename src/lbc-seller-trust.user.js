// ==UserScript==
// @name         LBC Seller-Trust Flag
// @namespace    https://github.com/gushmazuko
// @version      1.3.0
// @description  Flags Leboncoin ads from young sellers and displays seller ratings
// @match        https://www.leboncoin.fr/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// @updateURL    https://raw.githubusercontent.com/gushmazuko/lbc-seller-trust/main/src/lbc-seller-trust.user.js
// @downloadURL  https://raw.githubusercontent.com/gushmazuko/lbc-seller-trust/main/src/lbc-seller-trust.user.js
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const MS_IN_DAY = 86_400_000;
  const MAX_CONCURRENT = 4;

  const CARD_SELECTOR = '[data-qa-id="aditem_container"]';
  const BADGE_CONTAINER_SELECTOR = ".mb-md.flex.items-center.gap-sm";
  const PRICE_SELECTOR = 'p[data-test-id="price"]';

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------
  let monthsThreshold = GM_getValue("monthsThreshold", 6);

  GM_registerMenuCommand("Set age threshold (months)…", () => {
    const input = prompt(
      "Flag sellers registered less than how many months ago?",
      String(monthsThreshold)
    );
    if (input === null) return;
    const next = Math.max(1, Math.min(36, Number(input) || monthsThreshold));
    monthsThreshold = next;
    GM_setValue("monthsThreshold", next);
  });

  // ---------------------------------------------------------------------
  // Concurrency limiter — bounds burst API traffic (SPEC §5.6)
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
  // Trust engine — network + caching, no DOM (SPEC §5)
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

  const verdictCache = new Map(); // userId -> { trusted, reasons, rating, reviewCount }
  const inFlight = new Map(); // userId -> Promise<{ trusted, reasons, rating, reviewCount }>

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

        const reasons = [];
        if (!ageOk) reasons.push("young");

        const result = {
          trusted: reasons.length === 0,
          reasons,
          rating,
          reviewCount
        };
        verdictCache.set(key, result);
        return result;
      } catch (err) {
        logFetchFailure(err);
        return {
          trusted: true,
          reasons: [],
          rating: null,
          reviewCount: 0
        }; // fail-open — not cached, SPEC §5.5
      } finally {
        evalSemaphore.release();
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, promise);
    return promise;
  }

  // ---------------------------------------------------------------------
  // DOM layer — ad-card discovery and badges (SPEC §6)
  // ---------------------------------------------------------------------
  function isSearchPage() {
    return location.pathname.startsWith("/recherche");
  }

  const REASON_LABEL = {
    young: "new"
  };

  const REASON_TEXT = {
    young: () => `new account (< ${monthsThreshold} months)`
  };

  function addBadge(card, reasons) {
    if (!card.isConnected) return;
    if (card.querySelector(".lbc-no-trust")) return;

    const badge = document.createElement("div");
    badge.textContent = reasons.map(r => REASON_LABEL[r]).join(" + ");
    badge.className = "lbc-no-trust";
    badge.title = `Seller: ${reasons.map(r => REASON_TEXT[r]()).join(" and ")}`;
    Object.assign(badge.style, {
      color: "white",
      background: "#c0392b",
      fontSize: "12px",
      padding: "2px 6px",
      borderRadius: "4px",
      display: "inline-block",
      marginLeft: "4px"
    });

    const flexContainer = card.querySelector(BADGE_CONTAINER_SELECTOR);
    if (flexContainer) {
      flexContainer.appendChild(badge);
      return;
    }
    const priceEl = card.querySelector(PRICE_SELECTOR) || card;
    priceEl.appendChild(badge);
  }

  function addRating(card, rating, reviewCount) {
    if (!card.isConnected) return;
    if (rating === null) return;
    if (card.querySelector(".lbc-seller-rating")) return;

    const badge = document.createElement("div");
    const formattedRating = rating.toFixed(1).replace(".", ",");
    badge.textContent = `★ ${formattedRating}/5 (${reviewCount} avis)`;
    badge.className = "lbc-seller-rating";
    badge.title = `Seller rating: ${formattedRating}/5 from ${reviewCount} review${reviewCount > 1 ? "s" : ""}`;
    Object.assign(badge.style, {
      color: "#1a1a1a",
      background: "#f2f2f2",
      fontSize: "12px",
      fontWeight: "600",
      padding: "2px 6px",
      borderRadius: "4px",
      display: "inline-block",
      marginLeft: "4px"
    });

    const flexContainer = card.querySelector(BADGE_CONTAINER_SELECTOR);
    if (flexContainer) {
      flexContainer.appendChild(badge);
      return;
    }
    const priceEl = card.querySelector(PRICE_SELECTOR) || card;
    priceEl.appendChild(badge);
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
          ({ trusted, reasons, rating, reviewCount }) => {
            addRating(card, rating, reviewCount);

            if (!trusted) addBadge(card, reasons);
          }
        );
      })
      .catch(logFetchFailure);
  }

  function processAllAds() {
    document.querySelectorAll(CARD_SELECTOR).forEach(processNode);
  }

  processAllAds();

  new MutationObserver(muts => {
    muts.forEach(m => {
      m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.matches?.(CARD_SELECTOR)) processNode(n);
        n.querySelectorAll?.(CARD_SELECTOR).forEach(processNode);
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
