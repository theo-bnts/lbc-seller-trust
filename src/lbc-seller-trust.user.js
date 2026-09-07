// ==UserScript==
// @name         LBC Seller-Trust Filter
// @namespace    https://github.com/theo-bnts
// @version      2.1.0
// @description  Filters Leboncoin ads by seller trust, removes sponsored content, classifies prices and skips pages where every listing is hidden
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

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const MS_IN_DAY = 86_400_000;

  const MAX_CONCURRENT = 4;
  const MIN_PRICES_FOR_CLASSIFICATION = 6;

  // Wait a little after the last DOM/filtering activity before deciding that
  // the page really contains no visible listing.
  const AUTO_NEXT_DELAY_MS = 800;

  const CARD_SELECTOR = '[data-qa-id="aditem_container"]';
  const AD_LINK_SELECTOR = 'a[href*="/ad/"]';

  const NEXT_PAGE_SELECTOR = [
    'a[data-spark-component="pagination-next-trigger"][href]',
    'a[data-scope="pagination"][data-part="next-trigger"][href]'
  ].join(",");

  const SELLER_HIDDEN_CLASS = "lbc-trust-seller-hidden";
  const NON_LISTING_HIDDEN_CLASS = "lbc-trust-non-listing-hidden";
  const PRICE_LABEL_CLASS = "lbc-trust-price-label";

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  let monthsThreshold = GM_getValue("monthsThreshold", 6);
  let minRating = GM_getValue("minRating", 4.5);
  let minReviews = GM_getValue("minReviews", 3);
  let autoNextPage = GM_getValue("autoNextPage", true);

  GM_registerMenuCommand("Set age threshold (months)…", () => {
    const input = prompt(
      "Hide sellers registered less than how many months ago?\n" +
        "Set 0 to disable this filter.",
      String(monthsThreshold)
    );

    if (input === null) {
      return;
    }

    const parsed = Number(input);

    if (!Number.isFinite(parsed)) {
      return;
    }

    const next = Math.max(
      0,
      Math.min(36, Math.round(parsed))
    );

    monthsThreshold = next;
    GM_setValue("monthsThreshold", next);

    location.reload();
  });

  GM_registerMenuCommand("Set minimum rating…", () => {
    const input = prompt(
      "Hide sellers rated below what score out of 5?\n" +
        "Set 0 to disable this filter.",
      String(minRating)
    );

    if (input === null) {
      return;
    }

    const parsed = Number(input.replace(",", "."));

    if (!Number.isFinite(parsed)) {
      return;
    }

    const next = Math.max(
      0,
      Math.min(5, Math.round(parsed * 10) / 10)
    );

    minRating = next;
    GM_setValue("minRating", next);

    location.reload();
  });

  GM_registerMenuCommand("Set minimum reviews…", () => {
    const input = prompt(
      "Hide sellers with fewer than how many reviews?\n" +
        "Set 0 to disable this filter.",
      String(minReviews)
    );

    if (input === null) {
      return;
    }

    const parsed = Number(input);

    if (!Number.isFinite(parsed)) {
      return;
    }

    const next = Math.max(
      0,
      Math.min(10_000, Math.round(parsed))
    );

    minReviews = next;
    GM_setValue("minReviews", next);

    location.reload();
  });

  GM_registerMenuCommand(
    autoNextPage
      ? "Disable automatic next page"
      : "Enable automatic next page",
    () => {
      autoNextPage = !autoNextPage;
      GM_setValue("autoNextPage", autoNextPage);

      location.reload();
    }
  );

  // ---------------------------------------------------------------------------
  // Concurrency limiter
  // ---------------------------------------------------------------------------

  function createSemaphore(limit) {
    let active = 0;
    const queue = [];

    function next() {
      while (queue.length > 0 && active < limit) {
        active++;

        const resolve = queue.shift();
        resolve();
      }
    }

    return {
      acquire() {
        return new Promise(resolve => {
          queue.push(resolve);
          next();
        });
      },

      release() {
        active = Math.max(0, active - 1);
        next();
      }
    };
  }

  const evalSemaphore = createSemaphore(MAX_CONCURRENT);

  // ---------------------------------------------------------------------------
  // Network helpers
  // ---------------------------------------------------------------------------

  function blockedError(url, detail) {
    const error = new Error(
      `possibly blocked by anti-bot protection — ${url} (${detail})`
    );

    error.blocked = true;

    return error;
  }

  async function fetchJson(url, init) {
    const response = await fetch(url, {
      credentials: "include",
      ...init
    });

    const contentType =
      response.headers.get("content-type") || "";

    const looksJson = contentType.includes("json");

    if (!response.ok) {
      if (
        !looksJson ||
        response.status === 403 ||
        response.status === 429
      ) {
        throw blockedError(
          url,
          `HTTP ${response.status}, content-type "${contentType}"`
        );
      }

      throw new Error(
        `${url} → HTTP ${response.status}`
      );
    }

    if (!looksJson) {
      throw blockedError(
        url,
        `unexpected content-type "${contentType}" on 200`
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw blockedError(
        url,
        `JSON parse failed: ${error.message}`
      );
    }
  }

  let blockedCount = 0;

  const BLOCKED_LOG_EVERY = 20;

  function logFetchFailure(error) {
    if (error?.blocked) {
      blockedCount++;

      if (
        blockedCount === 1 ||
        blockedCount % BLOCKED_LOG_EVERY === 0
      ) {
        console.error(
          `[lbc-trust] possibly blocked by anti-bot protection ` +
            `(${blockedCount} occurrence${blockedCount > 1 ? "s" : ""} ` +
            "this session)",
          error
        );
      }

      return;
    }

    console.warn("[lbc-trust]", error);
  }

  // ---------------------------------------------------------------------------
  // Classified lookup
  // ---------------------------------------------------------------------------

  const classifiedCache = new Map();

  function getClassified(listId) {
    if (!classifiedCache.has(listId)) {
      const promise = fetchJson(
        `https://api.leboncoin.fr/finder/classified/${encodeURIComponent(
          listId
        )}`
      );

      promise.catch(() => {
        classifiedCache.delete(listId);
      });

      classifiedCache.set(listId, promise);
    }

    return classifiedCache.get(listId);
  }

  // ---------------------------------------------------------------------------
  // Seller lookup
  // ---------------------------------------------------------------------------

  const userInfoCache = new Map();

  function getUserInfo(userId) {
    if (!userInfoCache.has(userId)) {
      const promise = fetchJson(
        `https://api.leboncoin.fr/api/user-card/v1/${encodeURIComponent(
          userId
        )}/infos`
      );

      promise.catch(() => {
        userInfoCache.delete(userId);
      });

      userInfoCache.set(userId, promise);
    }

    return userInfoCache.get(userId);
  }

  // ---------------------------------------------------------------------------
  // Seller evaluation
  // ---------------------------------------------------------------------------

  function computeAgeOk(registeredAt) {
    const registeredMs = Date.parse(registeredAt);

    if (Number.isNaN(registeredMs)) {
      throw new Error(
        `unparseable registered_at: ${registeredAt}`
      );
    }

    const minimumAge =
      monthsThreshold *
      30.4375 *
      MS_IN_DAY;

    return Date.now() - registeredMs >= minimumAge;
  }

  const verdictCache = new Map();
  const inFlight = new Map();

  function evaluateSeller(userId) {
    if (verdictCache.has(userId)) {
      return Promise.resolve(
        verdictCache.get(userId)
      );
    }

    if (inFlight.has(userId)) {
      return inFlight.get(userId);
    }

    const promise = (async () => {
      await evalSemaphore.acquire();

      try {
        const userInfo =
          await getUserInfo(userId);

        const ageOk =
          monthsThreshold === 0 ||
          computeAgeOk(userInfo.registered_at);

        const overallScore = Number(
          userInfo.feedback?.overall_score
        );

        const receivedCount = Number(
          userInfo.feedback?.received_count
        );

        const rating = Number.isFinite(overallScore)
          ? Math.max(
              0,
              Math.min(5, overallScore * 5)
            )
          : null;

        const reviewCount =
          Number.isFinite(receivedCount)
            ? receivedCount
            : 0;

        const ratingOk =
          minRating === 0 ||
          (
            rating !== null &&
            rating >= minRating
          );

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
      } catch (error) {
        logFetchFailure(error);

        // Fail-open:
        // if the API request fails, keep the ad visible.
        return { hide: false };
      } finally {
        evalSemaphore.release();
        inFlight.delete(userId);
      }
    })();

    inFlight.set(userId, promise);

    return promise;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function isSearchPage() {
    return location.pathname.startsWith("/recherche");
  }

  function getCardItem(card) {
    return (
      card.closest('li[class*="styles_adCard"]') ||
      card.closest("li") ||
      card
    );
  }

  function getListId(card) {
    const link = card.querySelector(
      AD_LINK_SELECTOR
    );

    if (!link) {
      return null;
    }

    const parts = link.pathname
      .split("/")
      .filter(Boolean);

    const listId =
      parts[parts.length - 1] || "";

    return /^\d+$/.test(listId)
      ? listId
      : null;
  }

  function setCardHidden(card, hidden) {
    if (!card.isConnected) {
      return;
    }

    const item = getCardItem(card);

    item.classList.toggle(
      SELLER_HIDDEN_CLASS,
      hidden
    );
  }

  function isCardVisible(card) {
    if (!card.isConnected) {
      return false;
    }

    const item = getCardItem(card);

    return (
      !item.classList.contains(
        SELLER_HIDDEN_CLASS
      ) &&
      !item.classList.contains(
        NON_LISTING_HIDDEN_CLASS
      )
    );
  }

  function getListingCards() {
    return Array.from(
      document.querySelectorAll(CARD_SELECTOR)
    ).filter(card => {
      return Boolean(
        card.querySelector(AD_LINK_SELECTOR)
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Non-listing / sponsored items
  // ---------------------------------------------------------------------------

  function filterNonListingItems() {
    if (!isSearchPage()) {
      return;
    }

    const lists = new Set();

    document
      .querySelectorAll(CARD_SELECTOR)
      .forEach(card => {
        const list = card.closest("ul");

        if (list) {
          lists.add(list);
        }
      });

    lists.forEach(list => {
      Array.from(list.children).forEach(item => {
        if (item.tagName !== "LI") {
          return;
        }

        const isListing = Boolean(
          item.querySelector(
            AD_LINK_SELECTOR
          )
        );

        item.classList.toggle(
          NON_LISTING_HIDDEN_CLASS,
          !isListing
        );
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Price classification
  // ---------------------------------------------------------------------------

  function parsePrice(text) {
    const match = text.match(
      /(\d[\d\s\u00A0\u202F]*(?:[.,]\d{1,2})?)\s*€/
    );

    if (!match) {
      return null;
    }

    const value = Number(
      match[1]
        .replace(
          /[\s\u00A0\u202F]/g,
          ""
        )
        .replace(",", ".")
    );

    return Number.isFinite(value)
      ? value
      : null;
  }

  function getCardPrice(card) {
    const accessiblePrice =
      Array.from(
        card.querySelectorAll("p")
      ).find(p => {
        return /^Prix\s*:/i.test(
          p.textContent.trim()
        );
      });

    if (accessiblePrice) {
      const price = parsePrice(
        accessiblePrice.textContent
      );

      if (price !== null) {
        return price;
      }
    }

    const testPrice =
      card.querySelector(
        'p[data-test-id="price"]'
      );

    if (testPrice) {
      const price = parsePrice(
        testPrice.textContent
      );

      if (price !== null) {
        return price;
      }
    }

    const visiblePrice =
      Array.from(
        card.querySelectorAll("p")
      ).find(p => {
        const text =
          p.textContent.trim();

        return (
          /€/.test(text) &&
          !/^Prix\s*:/i.test(text) &&
          !/^dès\s+/i.test(text)
        );
      });

    return visiblePrice
      ? parsePrice(
          visiblePrice.textContent
        )
      : null;
  }

  function getVisiblePriceElement(card) {
    const testPrice =
      card.querySelector(
        'p[data-test-id="price"]'
      );

    if (testPrice) {
      return testPrice;
    }

    return (
      Array.from(
        card.querySelectorAll("p")
      ).find(p => {
        const text =
          p.textContent.trim();

        return (
          /€/.test(text) &&
          !/^Prix\s*:/i.test(text) &&
          !/^dès\s+/i.test(text) &&
          !p.classList.contains(
            "sr-only"
          )
        );
      }) || null
    );
  }

  function percentile(
    sortedValues,
    percentileValue
  ) {
    if (sortedValues.length === 0) {
      return null;
    }

    const index =
      (sortedValues.length - 1) *
      percentileValue;

    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
      return sortedValues[lower];
    }

    const weight =
      index - lower;

    return (
      sortedValues[lower] *
        (1 - weight) +
      sortedValues[upper] *
        weight
    );
  }

  function setPriceLabel(card, label) {
    const existing =
      card.querySelector(
        `.${PRICE_LABEL_CLASS}`
      );

    if (!label) {
      existing?.remove();
      return;
    }

    const nextText = `(${label})`;

    if (existing) {
      if (
        existing.textContent !== nextText
      ) {
        existing.textContent =
          nextText;
      }

      return;
    }

    const priceElement =
      getVisiblePriceElement(card);

    if (!priceElement) {
      return;
    }

    const marker =
      document.createElement("span");

    marker.className =
      PRICE_LABEL_CLASS;

    marker.textContent =
      nextText;

    priceElement.appendChild(marker);
  }

  let pendingEvaluations = 0;
  let priceClassificationTimer = null;

  function classifyVisiblePrices() {
    if (!isSearchPage()) {
      return;
    }

    if (pendingEvaluations !== 0) {
      return;
    }

    const cards =
      Array.from(
        document.querySelectorAll(
          CARD_SELECTOR
        )
      );

    const pricedCards = cards
      .filter(isCardVisible)
      .map(card => ({
        card,
        price: getCardPrice(card)
      }))
      .filter(entry => {
        return entry.price !== null;
      });

    if (
      pricedCards.length <
      MIN_PRICES_FOR_CLASSIFICATION
    ) {
      cards.forEach(card => {
        setPriceLabel(card, null);
      });

      return;
    }

    const prices = pricedCards
      .map(entry => entry.price)
      .sort((a, b) => a - b);

    const p33 =
      percentile(prices, 0.33);

    const p66 =
      percentile(prices, 0.66);

    if (
      p33 === null ||
      p66 === null
    ) {
      cards.forEach(card => {
        setPriceLabel(card, null);
      });

      return;
    }

    const pricedCardSet =
      new Set(
        pricedCards.map(
          entry => entry.card
        )
      );

    cards.forEach(card => {
      if (
        !pricedCardSet.has(card)
      ) {
        setPriceLabel(
          card,
          null
        );
      }
    });

    pricedCards.forEach(
      ({ card, price }) => {
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

        setPriceLabel(
          card,
          label
        );
      }
    );
  }

  function schedulePriceClassification() {
    clearTimeout(
      priceClassificationTimer
    );

    priceClassificationTimer =
      setTimeout(() => {
        if (
          pendingEvaluations === 0
        ) {
          classifyVisiblePrices();
        }
      }, 150);
  }

  // ---------------------------------------------------------------------------
  // Card processing
  // ---------------------------------------------------------------------------

  // card -> listId
  const processedCards =
    new WeakMap();

  async function processNode(card) {
    if (!isSearchPage()) {
      return;
    }

    if (!card.isConnected) {
      return;
    }

    const listId =
      getListId(card);

    if (!listId) {
      return;
    }

    // React can reuse the same DOM element for another listing.
    if (
      processedCards.get(card) ===
      listId
    ) {
      return;
    }

    processedCards.set(
      card,
      listId
    );

    // Clear state from a potentially reused node.
    setCardHidden(
      card,
      false
    );

    setPriceLabel(
      card,
      null
    );

    // No need to query seller APIs if every seller filter is disabled.
    if (
      monthsThreshold === 0 &&
      minRating === 0 &&
      minReviews === 0
    ) {
      schedulePostProcessing();
      return;
    }

    pendingEvaluations++;

    try {
      const data =
        await getClassified(
          listId
        );

      const userId =
        data.owner?.user_id;

      if (!userId) {
        return;
      }

      const { hide } =
        await evaluateSeller(
          userId
        );

      // React might have reused the card while the requests were running.
      if (
        processedCards.get(card) !==
        listId
      ) {
        return;
      }

      setCardHidden(
        card,
        hide
      );
    } catch (error) {
      // An API failure must prevent auto-pagination from treating this card
      // as successfully filtered.
      processedCards.delete(card);

      logFetchFailure(error);
    } finally {
      pendingEvaluations--;

      schedulePostProcessing();
    }
  }

  // ---------------------------------------------------------------------------
  // Automatic pagination
  // ---------------------------------------------------------------------------

  let autoNextTimer = null;
  let autoNextTriggered = false;

  function getNextPageUrl() {
    const link =
      document.querySelector(
        NEXT_PAGE_SELECTOR
      );

    if (!link) {
      return null;
    }

    try {
      return new URL(
        link.href,
        location.href
      );
    } catch {
      return null;
    }
  }

  function isForwardPage(nextUrl) {
    const currentUrl =
      new URL(location.href);

    const currentPageRaw =
      currentUrl.searchParams.get(
        "page"
      );

    const nextPageRaw =
      nextUrl.searchParams.get(
        "page"
      );

    // Leboncoin's first search page may have no explicit ?page=1.
    const currentPage =
      currentPageRaw === null
        ? 1
        : Number(currentPageRaw);

    const nextPage =
      Number(nextPageRaw);

    if (
      !Number.isInteger(currentPage) ||
      !Number.isInteger(nextPage)
    ) {
      return false;
    }

    return nextPage > currentPage;
  }

  function canAutoAdvance() {
    if (!autoNextPage) {
      return false;
    }

    if (autoNextTriggered) {
      return false;
    }

    if (!isSearchPage()) {
      return false;
    }

    // Some seller evaluations are still running.
    if (pendingEvaluations !== 0) {
      return false;
    }

    const cards =
      getListingCards();

    // Important:
    // an empty DOM may simply mean that the search page has not loaded yet.
    if (cards.length === 0) {
      return false;
    }

    // Every currently displayed listing needs to have been processed
    // successfully. If one request failed, don't skip the page.
    const allProcessed =
      cards.every(card => {
        const listId =
          getListId(card);

        return (
          listId !== null &&
          processedCards.get(card) ===
            listId
        );
      });

    if (!allProcessed) {
      return false;
    }

    // This is the actual condition requested:
    // every real listing on the page is hidden.
    const allHidden =
      cards.every(card => {
        return !isCardVisible(card);
      });

    if (!allHidden) {
      return false;
    }

    return true;
  }

  function maybeGoToNextPage() {
    if (!canAutoAdvance()) {
      return;
    }

    const nextUrl =
      getNextPageUrl();

    // Last page: no "next" button.
    if (!nextUrl) {
      console.info(
        "[lbc-trust] All listings are hidden, but there is no next page."
      );

      return;
    }

    // Protection against an unexpected/broken pagination link.
    if (!isForwardPage(nextUrl)) {
      console.warn(
        "[lbc-trust] Refusing automatic pagination because the target is not a forward page:",
        nextUrl.href
      );

      return;
    }

    autoNextTriggered = true;

    const currentPage =
      Number(
        new URL(location.href)
          .searchParams
          .get("page") || 1
      );

    const nextPage =
      Number(
        nextUrl.searchParams.get(
          "page"
        )
      );

    console.info(
      `[lbc-trust] All listings on page ${currentPage} are hidden. ` +
        `Moving automatically to page ${nextPage}.`
    );

    location.assign(
      nextUrl.href
    );
  }

  function scheduleAutoNextPageCheck() {
    if (!autoNextPage) {
      return;
    }

    clearTimeout(
      autoNextTimer
    );

    autoNextTimer =
      setTimeout(() => {
        maybeGoToNextPage();
      }, AUTO_NEXT_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // Combined post-processing
  // ---------------------------------------------------------------------------

  function schedulePostProcessing() {
    schedulePriceClassification();
    scheduleAutoNextPageCheck();
  }

  // ---------------------------------------------------------------------------
  // Process complete search page
  // ---------------------------------------------------------------------------

  function processAllAds() {
    if (!isSearchPage()) {
      return;
    }

    document
      .querySelectorAll(
        CARD_SELECTOR
      )
      .forEach(processNode);

    filterNonListingItems();
    schedulePostProcessing();
  }

  // ---------------------------------------------------------------------------
  // Initial processing
  // ---------------------------------------------------------------------------

  processAllAds();

  // ---------------------------------------------------------------------------
  // Dynamic React updates
  // ---------------------------------------------------------------------------

  const observer =
    new MutationObserver(
      mutations => {
        if (!isSearchPage()) {
          return;
        }

        for (
          const mutation of mutations
        ) {
          for (
            const node of
            mutation.addedNodes
          ) {
            if (
              node.nodeType !==
              Node.ELEMENT_NODE
            ) {
              continue;
            }

            const element = node;

            if (
              element.matches?.(
                CARD_SELECTOR
              )
            ) {
              processNode(element);
            }

            const parentCard =
              element.closest?.(
                CARD_SELECTOR
              );

            if (parentCard) {
              processNode(
                parentCard
              );
            }

            element
              .querySelectorAll?.(
                CARD_SELECTOR
              )
              .forEach(
                processNode
              );
          }
        }

        filterNonListingItems();
        schedulePostProcessing();
      }
    );

  observer.observe(
    document.body,
    {
      childList: true,
      subtree: true
    }
  );
})();
