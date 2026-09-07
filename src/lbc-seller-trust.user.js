// ==UserScript==
// @name         LBC Seller-Trust Filter
// @namespace    https://github.com/theo-bnts
// @version      2.0.0
// @description  Filters Leboncoin ads by seller trust, removes sponsored content and classifies listing prices
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
  const MIN_PRICES_FOR_CLASSIFICATION = 9;

  const CARD_SELECTOR = '[data-qa-id="aditem_container"]';
  const AD_LINK_SELECTOR = 'a[href*="/ad/"]';

  const SELLER_HIDDEN_CLASS = "lbc-trust-seller-hidden";
  const NON_LISTING_HIDDEN_CLASS = "lbc-trust-non-listing-hidden";
  const PRICE_LABEL_CLASS = "lbc-trust-price-label";

  // ---------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------
  const style = document.createElement("style");
  style.textContent = `
    .${SELLER_HIDDEN_CLASS},
    .${NON_LISTING_HIDDEN_CLASS} {
      display: none !important;
    }

    .${PRICE_LABEL_CLASS} {
      margin-left: 4px;
      font-size: inherit;
      font-weight: 600;
    }
  `;
  document.head.appendChild(style);

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------
  let monthsThreshold = GM_getValue("monthsThreshold", 6);
  let minRating = GM_getValue("minRating", 4.5);
  let minReviews = GM_getValue("minReviews", 3);

  GM_registerMenuCommand("Set age threshold (months)…", () => {
    const input = prompt(
      "Hide sellers registered less than how many months ago?\nSet 0 to disable this filter.",
      String(monthsThreshold)
    );
    if (input === null) return;

    const parsed = Number(input);
    if (!Number.isFinite(parsed)) return;

    const next = Math.max(0, Math.min(36, Math.round(parsed)));

    monthsThreshold = next;
    GM_setValue("monthsThreshold", next);

    location.reload();
  });

  GM_registerMenuCommand("Set minimum rating…", () => {
    const input = prompt(
      "Hide sellers rated below what score out of 5?\nSet 0 to disable this filter.",
      String(minRating)
    );
    if (input === null) return;

    const parsed = Number(input.replace(",", "."));
    if (!Number.isFinite(parsed)) return;

    const next = Math.max(0, Math.min(5, Math.round(parsed * 10) / 10));

    minRating = next;
    GM_setValue("minRating", next);

    location.reload();
  });

  GM_registerMenuCommand("Set minimum reviews…", () => {
    const input = prompt(
      "Hide sellers with fewer than how many reviews?\nSet 0 to disable this filter.",
      String(minReviews)
    );
    if (input === null) return;

    const parsed = Number(input);
    if (!Number.isFinite(parsed)) return;

    const next = Math.max(0, Math.min(10_000, Math.round(parsed)));

    minReviews = next;
    GM_setValue("minReviews", next);

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

        const ageOk =
          monthsThreshold === 0 ||
          computeAgeOk(userInfo.registered_at);

        const overallScore = Number(userInfo.feedback?.overall_score);
        const receivedCount = Number(userInfo.feedback?.received_count);

        const rating = Number.isFinite(overallScore)
          ? Math.max(0, Math.min(5, overallScore * 5))
          : null;

        const reviewCount = Number.isFinite(receivedCount)
          ? receivedCount
          : 0;

        const ratingOk =
          minRating === 0 ||
          (rating !== null && rating >= minRating);

        const reviewsOk =
          minReviews === 0 ||
          reviewCount >= minReviews;

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

  function isCardVisible(card) {
    const item = getCardItem(card);

    return (
      card.isConnected &&
      !item.classList.contains(SELLER_HIDDEN_CLASS) &&
      !item.classList.contains(NON_LISTING_HIDDEN_CLASS)
    );
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
  // Price classification
  // ---------------------------------------------------------------------
  function parsePrice(text) {
    const match = text.match(
      /(\d[\d\s\u00A0\u202F]*(?:[.,]\d{1,2})?)\s*€/
    );

    if (!match) return null;

    const value = Number(
      match[1]
        .replace(/[\s\u00A0\u202F]/g, "")
        .replace(",", ".")
    );

    return Number.isFinite(value) ? value : null;
  }

  function getCardPrice(card) {
    const accessiblePrice = Array.from(card.querySelectorAll("p")).find(p => {
      return /^Prix\s*:/i.test(p.textContent.trim());
    });

    if (accessiblePrice) {
      const price = parsePrice(accessiblePrice.textContent);

      if (price !== null) {
        return price;
      }
    }

    const testPrice = card.querySelector('p[data-test-id="price"]');

    if (testPrice) {
      const price = parsePrice(testPrice.textContent);

      if (price !== null) {
        return price;
      }
    }

    const visiblePrice = Array.from(card.querySelectorAll("p")).find(p => {
      const text = p.textContent.trim();

      return (
        /€/.test(text) &&
        !/^Prix\s*:/i.test(text) &&
        !/^dès\s+/i.test(text)
      );
    });

    return visiblePrice
      ? parsePrice(visiblePrice.textContent)
      : null;
  }

  function getVisiblePriceElement(card) {
    const testPrice = card.querySelector('p[data-test-id="price"]');

    if (testPrice) {
      return testPrice;
    }

    return Array.from(card.querySelectorAll("p")).find(p => {
      const text = p.textContent.trim();

      return (
        /€/.test(text) &&
        !/^Prix\s*:/i.test(text) &&
        !/^dès\s+/i.test(text) &&
        !p.classList.contains("sr-only")
      );
    }) || null;
  }

  function percentile(sortedValues, percentileValue) {
    if (sortedValues.length === 0) return null;

    const index = (sortedValues.length - 1) * percentileValue;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
      return sortedValues[lower];
    }

    const weight = index - lower;

    return (
      sortedValues[lower] * (1 - weight) +
      sortedValues[upper] * weight
    );
  }

  function setPriceLabel(card, label) {
    const existing = card.querySelector(`.${PRICE_LABEL_CLASS}`);

    if (!label) {
      existing?.remove();
      return;
    }

    if (existing) {
      const nextText = `(${label})`;

      if (existing.textContent !== nextText) {
        existing.textContent = nextText;
      }

      return;
    }

    const priceElement = getVisiblePriceElement(card);
    if (!priceElement) return;

    const marker = document.createElement("span");
    marker.className = PRICE_LABEL_CLASS;
    marker.textContent = `(${label})`;

    priceElement.appendChild(marker);
  }

  let pendingEvaluations = 0;
  let priceClassificationTimer = null;

  function classifyVisiblePrices() {
    if (!isSearchPage()) return;
    if (pendingEvaluations !== 0) return;

    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));

    const pricedCards = cards
      .filter(isCardVisible)
      .map(card => ({
        card,
        price: getCardPrice(card)
      }))
      .filter(entry => entry.price !== null);

    if (pricedCards.length < MIN_PRICES_FOR_CLASSIFICATION) {
      cards.forEach(card => setPriceLabel(card, null));
      return;
    }

    const prices = pricedCards
      .map(entry => entry.price)
      .sort((a, b) => a - b);

    const p33 = percentile(prices, 0.33);
    const p66 = percentile(prices, 0.66);

    if (p33 === null || p66 === null) {
      cards.forEach(card => setPriceLabel(card, null));
      return;
    }

    const pricedCardSet = new Set(
      pricedCards.map(entry => entry.card)
    );

    cards.forEach(card => {
      if (!pricedCardSet.has(card)) {
        setPriceLabel(card, null);
      }
    });

    pricedCards.forEach(({ card, price }) => {
      let label;

      if (p33 === p66) {
        label = "Normal";
      } else if (price < p33) {
        label = "Bon";
      } else if (price < p66) {
        label = "Normal";
      } else {
        label = "Cher";
      }

      setPriceLabel(card, label);
    });
  }

  function schedulePriceClassification() {
    clearTimeout(priceClassificationTimer);

    priceClassificationTimer = setTimeout(() => {
      if (pendingEvaluations === 0) {
        classifyVisiblePrices();
      }
    }, 150);
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

    // Clear state that may belong to a previous listing rendered
    // inside the same DOM node.
    setCardHidden(card, false);
    setPriceLabel(card, null);

    // If every seller filter is disabled, no seller API lookup is needed.
    if (
      monthsThreshold === 0 &&
      minRating === 0 &&
      minReviews === 0
    ) {
      schedulePriceClassification();
      return;
    }

    pendingEvaluations++;

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
    } finally {
      pendingEvaluations--;
      schedulePriceClassification();
    }
  }

  function processAllAds() {
    if (!isSearchPage()) return;

    document.querySelectorAll(CARD_SELECTOR).forEach(processNode);
    filterNonListingItems();
    schedulePriceClassification();
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
    schedulePriceClassification();
  }).observe(document.body, {
    childList: true,
    subtree: true
  });
})();
