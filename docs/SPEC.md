# LBC Seller-Trust Filter — Userscript Specification

**Version:** 1.7.0
**Target platform:** Tampermonkey (Chrome, Firefox, Edge, Safari)
**Deliverable:** a single file, `src/lbc-seller-trust.user.js`

## 1. Purpose

Filter Leboncoin search-result ads whose seller does not meet configurable trust
requirements, directly in the results list.

A seller's ad is **hidden** when any of the following conditions is true:

1. **Account is too young** — registered less than a configurable number of months ago
   (default **6**).
2. **Rating is too low** — seller rating is below a configurable minimum
   (default **4.5 / 5**).
3. **Too few reviews** — seller has received fewer than a configurable number of reviews
   (default **3**).
4. **Rating is unavailable** — the seller profile does not expose a usable overall
   rating.

The script also hides sponsored and other non-listing elements inserted between normal
search results.

Visible ads are left unchanged: no badge, label, annotation, or reordering is added.

## 2. Scope

### In scope

- Search result pages: `https://www.leboncoin.fr/recherche*`, including results loaded
  dynamically and results replaced by client-side (SPA) navigation.
- Three user-configurable seller thresholds:
  - account age: `1–36` months, default `6`;
  - minimum rating: `0–5`, default `4.5`;
  - minimum reviews: `0–10,000`, default `3`.
- Settings stored in userscript storage and editable through the Tampermonkey menu.
- Automatic removal of non-listing `<li>` elements from Leboncoin result lists,
  including sponsored blocks, empty placeholders, video advertising, and similar
  promotional content.

### Out of scope (non-goals)

- Ad detail pages, seller profile pages, favorites, or messaging.
- An options page or popup.
- Persistence of seller verdicts or API responses across page loads.
- Reordering search results.
- Displaying seller ratings, review counts, account age, or trust badges on visible ads.

## 3. Script metadata

```javascript
// ==UserScript==
// @name         LBC Seller-Trust Filter
// @namespace    https://github.com/theo-bnts
// @version      1.8.0
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
```

Rationale:

- `@match https://www.leboncoin.fr/*` rather than `/recherche*`: the user may enter the
  site on another page and later reach search results through client-side navigation.
  The script is therefore injected site-wide but activates its filtering logic only
  when `location.pathname.startsWith("/recherche")`.
- `@noframes`: never run inside iframes.
- No `@connect` or `GM_xmlhttpRequest`: requests use normal `fetch()` with
  `credentials: "include"`.
- `@updateURL` and `@downloadURL` point directly at the raw `main`-branch userscript.
  `src/lbc-seller-trust.user.js` is the distributable file and `@version` must be bumped
  whenever a released script change is made.

## 4. Settings

| Key               | Type    | Default | Range    | Storage       |
| ----------------- | ------- | ------- | -------- | ------------- |
| `monthsThreshold` | integer | 6       | 1–36     | `GM_setValue` |
| `minRating`       | number  | 4.5     | 0–5      | `GM_setValue` |
| `minReviews`      | integer | 3       | 0–10,000 | `GM_setValue` |

All three settings are read at startup with `GM_getValue(key, default)`.

Three commands are registered using `GM_registerMenuCommand`:

### 4.1 Account age

**"Set age threshold (months)…"**

- Opens a `prompt()` pre-filled with the current value.
- Input must be numeric.
- Rounded to the nearest integer.
- Clamped to `[1, 36]`.
- Saved as `monthsThreshold`.

### 4.2 Minimum rating

**"Set minimum rating…"**

- Opens a `prompt()` pre-filled with the current value.
- Both decimal dots and decimal commas are accepted (`4.5` and `4,5`).
- Rounded to one decimal place.
- Clamped to `[0, 5]`.
- Saved as `minRating`.

### 4.3 Minimum reviews

**"Set minimum reviews…"**

- Opens a `prompt()` pre-filled with the current value.
- Input must be numeric.
- Rounded to the nearest integer.
- Clamped to `[0, 10_000]`.
- Saved as `minReviews`.

After a valid setting change, `location.reload()` is called so every result is
reevaluated using the new thresholds.

Invalid or cancelled input leaves the existing setting unchanged.

## 5. Seller evaluation

### 5.1 Inputs

For each ad card the script extracts:

- `listId` — the final numeric segment of the ad link pathname:
  `a[href*="/ad/"]`.
- `userId` — obtained from Leboncoin's classified endpoint (§5.2-A).

If `listId` is missing or non-numeric, the card is skipped.

If `owner.user_id` is missing, the card is left visible.

### 5.2 API calls

All API calls use:

```javascript
fetch(url, {
  credentials: "include"
})
```

A non-`ok` HTTP response, unexpected non-JSON response, JSON parse failure, or network
failure is treated as an evaluation failure and handled fail-open (§5.5).

#### A. Resolve the seller

```text
GET https://api.leboncoin.fr/finder/classified/{listId}
```

Returns the classified object.

Required field:

```text
owner.user_id
```

`listId` is passed through `encodeURIComponent()`.

The result is cached by listing ID for the lifetime of the page.

#### B. Fetch the seller profile

```text
GET https://api.leboncoin.fr/api/user-card/v1/{userId}/infos
```

`userId` is passed through `encodeURIComponent()`.

The script reads:

```text
registered_at
feedback.overall_score
feedback.received_count
```

The complete profile response is cached by user ID for the lifetime of the page.

### 5.3 Account age

`registered_at` is parsed with `Date.parse()`.

```javascript
ageOk =
  Date.now() - Date.parse(registered_at) >=
  monthsThreshold * 30.4375 * 86_400_000;
```

`30.4375` days is used as the average month length.

If `registered_at` cannot be parsed, seller evaluation fails and the ad is left visible
under the fail-open policy.

### 5.4 Rating and review count

Leboncoin exposes:

```text
feedback.overall_score
```

as a normalized value from `0` to `1`.

The script converts it to a 5-star score:

```javascript
rating = overallScore * 5;
```

The resulting value is clamped to `[0, 5]`.

The review count is taken from:

```text
feedback.received_count
```

and defaults to `0` if no finite numeric value is available.

The checks are:

```javascript
ratingOk =
  rating !== null &&
  rating >= minRating;

reviewsOk =
  reviewCount >= minReviews;
```

An unavailable overall rating therefore fails the rating check.

### 5.5 Verdict

The seller's ad is hidden when any trust requirement fails:

```javascript
hide =
  !ageOk ||
  !ratingOk ||
  !reviewsOk;
```

Equivalent behavior:

```text
account too young     → hide
rating below minimum  → hide
rating unavailable    → hide
too few reviews       → hide
all requirements met  → keep visible
```

No reason labels are rendered in the DOM.

### 5.6 Error handling — fail-open and blocked-response detection

Seller evaluation is **fail-open**.

If an API or parsing failure prevents a reliable seller verdict, the script returns:

```javascript
{ hide: false }
```

and leaves the ad visible.

Failure verdicts are not added to the seller verdict cache.

Blocked-looking responses are distinguished from ordinary errors.

A response is considered potentially blocked by anti-bot protection when:

- HTTP status is `403` or `429`;
- the response `Content-Type` is not JSON;
- a `200` response unexpectedly contains non-JSON content;
- JSON parsing fails.

These errors are marked with:

```javascript
err.blocked = true;
```

Blocked errors are logged with `console.error()`:

- first occurrence;
- then every 20th occurrence during the page session.

Ordinary failures are logged using `console.warn()`.

Unhandled promise rejections must not occur.

### 5.7 Rate limiting

Seller profile evaluations use a FIFO semaphore:

```text
MAX_CONCURRENT = 4
```

At most four seller-evaluation chains may simultaneously perform their profile lookup
and trust calculation.

Excess evaluations wait in the semaphore queue.

The initial `/finder/classified/{listId}` resolution is cached but is not governed by
this semaphore.

## 6. Caching and deduplication

All caches are in memory and live only until the page is reloaded.

### 6.1 Classified cache

```javascript
Map<listId, Promise<classified>>
```

A listing ID is resolved through `/finder/classified/` at most once successfully per
page session.

Caching the promise also deduplicates concurrent requests.

A rejected request is removed from the cache so it may be retried later.

### 6.2 Seller profile cache

```javascript
Map<userId, Promise<userInfo>>
```

A seller profile is fetched at most once successfully per page session.

If multiple ads belong to the same seller, they share the same cached profile request.

Rejected requests are removed so later evaluations may retry.

### 6.3 Verdict cache

```javascript
Map<userId, { hide }>
```

The seller verdict is shared by all ads belonging to the same user because all current
trust checks are seller-level properties.

No listing ID or category ID is required in the verdict key.

### 6.4 In-flight seller evaluation map

```javascript
Map<userId, Promise<{ hide }>>
```

Concurrent evaluations for the same seller share the same pending evaluation.

The entry is deleted when the evaluation settles.

### 6.5 Processed DOM-card tracking

Cards are tracked using:

```javascript
WeakMap<cardNode, listId>
```

rather than a `WeakSet`.

This is necessary because Leboncoin's React frontend may reuse an existing DOM node for
a different listing.

A card is skipped only when the same DOM node is already associated with the same
`listId`.

When the node is reused for another `listId`, it is evaluated again.

## 7. Page integration

### 7.1 Activation

Filtering is active when:

```javascript
location.pathname.startsWith("/recherche")
```

The userscript remains loaded elsewhere on `leboncoin.fr` but seller processing and
non-listing filtering are no-ops outside search pages.

### 7.2 Card discovery

Card selector:

```css
[data-qa-id="aditem_container"]
```

Listing link selector:

```css
a[href*="/ad/"]
```

On startup:

1. all current card nodes are processed;
2. non-listing result elements are filtered.

One persistent `MutationObserver` is attached to `document.body` with:

```javascript
{
  childList: true,
  subtree: true
}
```

For each added element node:

- if the node itself matches the card selector, process it;
- if the node is inside an existing card, process the parent card;
- process any card descendants contained by the added node.

After each mutation batch, non-listing result items are filtered again.

### 7.3 React node reuse

Before evaluating a card, the script stores:

```javascript
processedCards.set(card, listId);
```

Any existing seller-hidden state is cleared before the new evaluation.

After asynchronous API calls complete, the script checks:

```javascript
processedCards.get(card) === listId
```

before applying the verdict.

This prevents a slow response for an old listing from hiding a DOM node that React has
already reused for another ad.

## 8. Hiding seller listings

Two CSS classes are injected into the page:

```css
.lbc-trust-seller-hidden,
.lbc-trust-non-listing-hidden {
  display: none !important;
}
```

Seller-filtered ads use:

```text
lbc-trust-seller-hidden
```

The target element is selected in this order:

1. nearest `li` whose class contains `styles_adCard`;
2. nearest generic `li`;
3. the card node itself.

Using a CSS class instead of directly changing inline `style.display` keeps DOM-state
management predictable and allows the class to be toggled cleanly if React reuses the
card.

Visible ads receive no additional DOM elements.

## 9. Sponsored and non-listing filtering

Leboncoin inserts non-classified elements inside the same `<ul>` structures as real
search results.

Observed examples include:

```html
<li></li>
<li>Sponsorisé</li>
<li>...video advertising...</li>
<li>...promotional/logo content...</li>
```

Rather than depending on individual advertising selectors, the script identifies real
result items by the presence of a normal listing link:

```css
a[href*="/ad/"]
```

For every result `<ul>` containing known ad cards, each direct `<li>` child is checked.

Conceptually:

```javascript
isListing = Boolean(item.querySelector('a[href*="/ad/"]'));
```

If `isListing === false`, the `<li>` receives:

```text
lbc-trust-non-listing-hidden
```

Otherwise that class is removed.

This strategy:

- removes sponsored content;
- removes empty advertising placeholders;
- prevents blank vertical gaps between listings;
- does not depend on specific advertising IDs or class names;
- automatically adapts when Leboncoin inserts new non-listing content using the same
  result-list structure.

Only direct `<li>` children of result lists associated with actual ad cards are
processed, rather than every list on the site.

## 10. Repository layout

```text
README.md
docs/SPEC.md
src/lbc-seller-trust.user.js
```

## 11. Acceptance criteria

1. On a `/recherche` page, a seller registered less than the configured age threshold
   has all evaluated ads hidden.
2. A seller whose normalized Leboncoin score converts to less than the configured
   minimum `/5` rating has all evaluated ads hidden.
3. A seller with fewer than the configured minimum number of reviews has all evaluated
   ads hidden.
4. A seller meeting all three configured thresholds remains visible and receives no
   badge, annotation, or additional UI.
5. A seller with no usable `feedback.overall_score` is hidden when profile retrieval
   itself succeeds.
6. Multiple ads from the same seller trigger only one successful seller-profile lookup
   per page session.
7. The same listing ID triggers only one successful `/finder/classified/` lookup per
   page session.
8. Infinite-scroll results are evaluated automatically without reloading the page.
9. If React reuses a card DOM node for another listing, the new listing is reevaluated
   and a delayed verdict from the previous listing cannot be applied to it.
10. Sponsored blocks, empty result placeholders, video ads, and other non-listing
    `<li>` elements between classified ads are hidden without leaving blank spaces.
11. With seller API requests blocked, offline, malformed, or returning HTTP errors,
    affected classified ads remain visible and no uncaught error is produced.
12. HTTP `403`/`429` and non-JSON blocked-looking responses produce throttled
    `console.error()` messages.
13. Changing any of the three thresholds through the Tampermonkey menu saves the new
    value and reloads the page.
14. The rating setting accepts both decimal-dot and decimal-comma input.
15. The script does not process seller cards on non-search pages.
16. The script never runs inside iframes.
