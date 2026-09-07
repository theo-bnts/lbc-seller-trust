# LBC Seller-Trust Filter

A Tampermonkey userscript that filters Leboncoin search results based on seller trust
signals and helps quickly compare listing prices.

## Why

Checking whether a seller looks trustworthy on Leboncoin normally means opening profiles
one by one to look at account age, ratings, and reviews.

This script does those checks automatically while browsing search results and hides
listings that do not meet the criteria you choose.

It also removes sponsored content and gives visible listings a simple price indication
based on the other prices currently shown in the search results.

## What it does

On `leboncoin.fr` search pages, each seller can be checked against three configurable
signals:

- **Account age** — seller must have been registered for at least a configurable number
  of months (default **6**).
- **Seller rating** — seller must have a rating of at least a configurable score
  (default **4.5 / 5**).
- **Review count** — seller must have received at least a configurable number of reviews
  (default **3**).

If any enabled check fails, the entire listing is hidden.

Each seller filter can be disabled independently by setting its threshold to `0`.

The script also hides sponsored blocks, video ads, empty placeholders, and other
non-listing elements inserted between normal search results.

## Price indication

Once seller filtering is complete, the script compares the prices of the remaining
visible listings on the page.

Listings are divided according to the price distribution:

- below the 33rd percentile → **(Bon)**
- from the 33rd to below the 66th percentile → **(Normal)**
- from the 66th percentile upward → **(Cher)**

The indication is displayed directly next to the listing price.

For example:

```text
270 € (Bon)
420 € (Normal)
650 € (Cher)
```

Only listings that remain visible after seller filtering are included in the
calculation.

At least **9 visible listings with a valid price** are required. If there are not enough
prices to make a useful comparison, no price indication is displayed.

The calculation is local and does not require any additional API request.

When more results are loaded, the price distribution is recalculated automatically.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the raw script and Tampermonkey will prompt to install it:
   `https://github.com/theo-bnts/lbc-seller-trust/raw/main/src/lbc-seller-trust.user.js`

## Configuration

All seller-trust thresholds are editable from the Tampermonkey menu:

| Setting                     | Range    | Default | `0` means |
| --------------------------- | -------- | ------- | --------- |
| Set age threshold (months)… | 0–36     | 6       | Disabled  |
| Set minimum rating…         | 0–5      | 4.5     | Disabled  |
| Set minimum reviews…        | 0–10,000 | 3       | Disabled  |

The minimum rating can be configured in increments of `0.1`.

Changing a setting reloads the page so all listings are evaluated again using the new
thresholds.

### Disabling individual filters

Setting a threshold to `0` completely disables that check.

For example:

- `age = 0`, `rating = 4.5`, `reviews = 3`:
  account age is ignored.
- `age = 6`, `rating = 0`, `reviews = 3`:
  the seller rating is ignored, including sellers without a rating.
- `age = 6`, `rating = 4.5`, `reviews = 0`:
  the number of reviews is ignored.
- all three values set to `0`:
  no seller is hidden based on profile trust signals.

Sponsored-content removal and price classification still work when the seller filters
are disabled.

## How it works

For each listing, the script resolves the seller through Leboncoin's internal
`/finder/classified/` endpoint.

It then fetches the seller profile through the internal `user-card` API and reads:

- `registered_at`
- `feedback.overall_score`
- `feedback.received_count`

Leboncoin's `overall_score` value is normalized from `0` to `1`, so the script converts
it to a 5-star rating before applying the configured minimum rating.

Seller profile lookups and classified lookups are cached in memory for the current page
session to avoid repeating the same API requests unnecessarily.

When enabled, listings are hidden if:

- the seller account is newer than the configured age threshold;
- the seller has fewer than the configured minimum number of reviews;
- the seller rating is below the configured minimum rating;
- or the seller rating is unavailable while the rating filter is enabled.

A filter whose threshold is set to `0` is skipped entirely.

If an API request fails, the script fails open and leaves the listing visible.

Prices are read directly from the listing cards already present in the page. No extra
network request is made for price classification.

The script also removes result-list elements that do not contain a normal `/ad/` link.
This removes sponsored content and prevents empty gaps from remaining between listings.

## Limitations

- Only active on `leboncoin.fr/recherche*` search pages — not ad detail pages, profiles,
  favorites, or messaging.
- No options page or popup — configuration is menu-only.
- Seller verdicts and API responses are cached in memory for the page session only.
- Price classification is relative to the currently loaded and visible listings. It is
  not an estimate of the true market value of a product.
- A broad search containing different products, models, storage capacities, conditions,
  or categories can make the price indication less meaningful.
- The script relies on undocumented Leboncoin internal APIs and DOM structure, which may
  change without notice.

## Disclaimer

Unofficial and not affiliated with Leboncoin.

The seller filters and price indications are only browsing aids. A **(Bon)** price does
not guarantee that an item is legitimate, correctly described, or actually a good deal.

The script relies on undocumented internal API endpoints and frontend behavior observed
through the browser. It may stop working if Leboncoin changes its API responses, search
result markup, or anti-bot protections.

Found a bug? Open an issue with the console output and the URL you were on.

## License

[MIT](LICENSE)
