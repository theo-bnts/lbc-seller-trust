// ==UserScript==
// @name         LBC Seller-Trust Filter
// @namespace    https://github.com/theo-bnts
// @version      1.7.0
// @description  Hides Leboncoin ads from young, poorly rated or low-review sellers and removes sponsored content
// @match        https://www.leboncoin.fr/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// @updateURL    https://raw.githubusercontent.com/theo-bnts/lbc-seller-trust/main/src/lbc-seller-trust.user.js
// @downloadURL  https://raw.githubusercontent.com/theo-bnts/lbc-seller-trust/main/src/lbc-seller-trust.user.js
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const MS_IN_DAY = 86_400_000;
  const MAX_CONCURRENT = 4;

  const CARD_SELECTOR = '[data-qa-id="aditem_container"]';
  const AD_LINK_SELECTOR = 'a[href*="/ad/"]';

  const SELLER_HIDDEN_CLASS = "lbc-trust-seller-hidden";
  const NON_LISTING_HIDDEN_CLASS = "lbc-trust-non-listing-hidden";

  const MIN_RATING = 4.5;
  const MIN_REVIEWS = 3;

  // ---------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------
  const style = document.createElement("style");
  style.textContent = `
    .${SELLER_HIDDEN_CLASS},
    .${NON_LISTING_HIDDEN_CLASS} {
      display: none !important;
    }
  `;
  document.head.appendChild(style);

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

    location.reload();
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
  // Network helpers
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

      return;
    }

    console.warn("[lbc-trust]", err);
  }

  // ---------------------------------------------------------------------
  // Classified lookup — memoised by listing ID
  // ---------------------------------------------------------------------
  const classifiedCache = new Map(); // listId -> Promise<object>

  function getClassified(listId) {
    if (!classifiedCache.has(listId)) {
      const promise = fetchJson(
        `https://api.leboncoin.fr/finder/classified/${encodeURIComponent(listId)}`
      );

      promise.catch(() => classifiedCache.delete(listId));
      classifiedCache.set(listId, promise);
    }

    return classifiedCache.get(listId);
  }

  // ---------------------------------------------------------------------
  // Seller profile lookup — memoised by user ID
  // ---------------------------------------------------------------------
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

  // ---------------------------------------------------------------------
  // Seller evaluation
  // ---------------------------------------------------------------------
  function computeAgeOk(registeredAt) {
    const registeredMs = Date.parse(registeredAt);

    if (Number.isNaN(registeredMs)) {
      throw new Error(`unparseable registered_at: ${registeredAt}`);
    }

    return Date.now() - registeredMs >= monthsThreshold * 30.4375 * MS_IN_DAY;
  }

  const verdictCache = new Map(); // userId -> { hide }
  const inFlight = new Map(); // userId -> Promise<{ hide }>

  function evaluateSeller(userId) {
    if (verdictCache.has(userId)) {
      return Promise.resolve(verdictCache.get(userId));
    }

    if (inFlight.has(userId)) {
      return inFlight.get(userId);
    }

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

        const ratingOk =
          rating !== null &&
          rating >= MIN_RATING;

        const reviewsOk =
          reviewCount >= MIN_REVIEWS;

        const hide =
          !ageOk ||
          !ratingOk ||
          !reviewsOk;

        const result = { hide };
        verdictCache.set(userId, result);

        return result;
      } catch (err) {
        logFetchFailure(err);
        return { hide: false }; // fail-open — not cached
      } finally {
        evalSemaphore.release();
        inFlight.delete(userId);
      }
    })();

    inFlight.set(userId, promise);
    return promise;
  }

  // ---------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------
  function isSearchPage() {
    return location.pathname.startsWith("/recherche");
  }

  function getCardItem(card) {
    return card.closest('li[class*="styles_adCard"]') || card.closest("li") || card;
  }

  function setCardHidden(card, hidden) {
    if (!card.isConnected) return;

    const item = getCardItem(card);
    item.classList.toggle(SELLER_HIDDEN_CLASS, hidden);
  }

  // Leboncoin inserts several non-listing <li> elements between real ads:
  // sponsored blocks, empty placeholders, video ads, logos, etc.
  // Real classified items contain an "/ad/" link, so non-listing items can
  // safely be removed from the result lists.
  function filterNonListingItems() {
    if (!isSearchPage()) return;

    const lists = new Set();

    document.querySelectorAll(CARD_SELECTOR).forEach(card => {
      const list = card.closest("ul");

      if (list) {
        lists.add(list);
      }
    });

    lists.forEach(list => {
      Array.from(list.children).forEach(item => {
        if (item.tagName !== "LI") return;

        const isListing = Boolean(item.querySelector(AD_LINK_SELECTOR));

        item.classList.toggle(
          NON_LISTING_HIDDEN_CLASS,
          !isListing
        );
      });
    });
  }

  // ---------------------------------------------------------------------
  // Ad-card processing
  // ---------------------------------------------------------------------
  const processedCards = new WeakMap(); // card -> listId

  async function processNode(card) {
    if (!isSearchPage()) return;
    if (!card.isConnected) return;

    const link = card.querySelector(AD_LINK_SELECTOR);
    if (!link) return;

    const listId = link.pathname.split("/").pop();
    if (!/^\d+$/.test(listId)) return;

    // React may reuse an existing DOM node for another listing.
    if (processedCards.get(card) === listId) return;

    processedCards.set(card, listId);

    // Clear a verdict that may belong to a previous listing rendered
    // inside the same DOM node.
    setCardHidden(card, false);

    try {
      const data = await getClassified(listId);
      const userId = data.owner?.user_id;

      if (!userId) return;

      const { hide } = await evaluateSeller(userId);

      // The card may have been reused while the API requests were running.
      if (processedCards.get(card) !== listId) return;

      setCardHidden(card, hide);
    } catch (err) {
      processedCards.delete(card);
      logFetchFailure(err);
    }
  }

  function processAllAds() {
    if (!isSearchPage()) return;

    document.querySelectorAll(CARD_SELECTOR).forEach(processNode);
    filterNonListingItems();
  }

  // ---------------------------------------------------------------------
  // Initial processing + dynamic result loading
  // ---------------------------------------------------------------------
  processAllAds();

  new MutationObserver(muts => {
    if (!isSearchPage()) return;

    muts.forEach(m => {
      m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;

        if (n.matches?.(CARD_SELECTOR)) {
          processNode(n);
        }

        const parentCard = n.closest?.(CARD_SELECTOR);

        if (parentCard) {
          processNode(parentCard);
        }

        n.querySelectorAll?.(CARD_SELECTOR).forEach(processNode);
      });
    });

    filterNonListingItems();
  }).observe(document.body, {
    childList: true,
    subtree: true
  });
})();
