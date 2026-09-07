# LBC Seller-Trust Filter

A Tampermonkey userscript that filters Leboncoin search results based on seller trust signals, removes unwanted content, and helps compare listing prices.

## Why

Checking whether a seller looks trustworthy on Leboncoin normally means opening profiles one by one to look at account age, ratings, and reviews.

This script does those checks automatically while browsing search results and hides listings that do not meet the criteria you choose.

It also removes sponsored content, gives visible listings a simple price indication, and can automatically skip pages where every listing has been filtered out.

## What it does

On `leboncoin.fr` search pages, each seller can be checked against three configurable signals:

- **Account age** — minimum account age in months (default **6**).
- **Seller rating** — minimum rating out of 5 (default **4.5**).
- **Review count** — minimum number of received reviews (default **3**).

If any enabled check fails, the listing is hidden.

Each seller filter can be disabled independently by setting its threshold to `0`.

The script also:

- hides sponsored blocks, video ads, placeholders, and other non-listing elements;
- classifies visible listing prices as **(Bon)**, **(Normal)**, or **(Cher)**;
- automatically moves to the next search page when every real listing on the current page has been hidden.

Automatic pagination can be enabled or disabled from the Tampermonkey menu.

## Price indication

Once seller filtering is complete, the script compares the prices of the remaining visible listings.

Listings are classified according to the current page's price distribution:

- below the 33rd percentile → **(Bon)**
- from the 33rd to below the 66th percentile → **(Normal)**
- from the 66th percentile upward → **(Cher)**

For example:

```text
270 € (Bon)
420 € (Normal)
650 € (Cher)
```

At least **6 visible listings with a valid price** are required. Otherwise, no price indication is displayed.

The calculation is local and does not require additional API requests.

## Automatic pagination

If every real listing on a search page is hidden by the seller filters, the script automatically opens the next results page.

It waits until all seller checks on the current page have completed before deciding whether to continue.

If at least one listing remains visible, the page is left unchanged.

Automatic pagination stops naturally when there is no next page and can be disabled from the Tampermonkey menu.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the raw script and Tampermonkey will prompt to install it:  
   `https://github.com/theo-bnts/lbc-seller-trust/raw/main/src/lbc-seller-trust.user.js`

## Configuration

Settings are available from the Tampermonkey menu:

| Setting | Range | Default | `0` means |
| --- | --- | --- | --- |
| Set age threshold (months)… | 0–36 | 6 | Disabled |
| Set minimum rating… | 0–5 | 4.5 | Disabled |
| Set minimum reviews… | 0–10,000 | 3 | Disabled |

The minimum rating can be configured in increments of `0.1`.

The menu also includes an option to enable or disable **automatic next-page navigation**.

Changing a seller threshold reloads the page so listings are evaluated again using the new settings.

Setting all three seller thresholds to `0` disables seller filtering entirely. Sponsored-content removal and price classification continue to work.

## How it works

For each listing, the script resolves the seller through Leboncoin's internal `/finder/classified/` endpoint.

It then fetches the seller profile through the internal `user-card` API and reads:

- `registered_at`
- `feedback.overall_score`
- `feedback.received_count`

Leboncoin's `overall_score` is normalized from `0` to `1`, so the script converts it to a 5-star rating before applying the configured threshold.

API responses and seller verdicts are cached in memory during the page session to avoid unnecessary duplicate requests.

If an API request fails, the script **fails open** and leaves the affected listing visible.

Prices are read directly from the listing cards already present in the page.

Non-listing result elements are detected by the absence of a normal `/ad/` link and hidden.

Before automatically moving to another page, the script verifies that all current listings have finished processing and that none remain visible.

## Limitations

- Only active on `leboncoin.fr/recherche*` search pages.
- Configuration is available through the Tampermonkey menu only.
- Seller verdicts and API responses are cached in memory for the current page session only.
- Price classification is relative to the currently visible listings and is not an estimate of true market value.
- Broad searches mixing different products, models, capacities, conditions, or categories can make price indications less meaningful.
- The script relies on undocumented Leboncoin APIs and DOM structure, which may change without notice.

## Disclaimer

Unofficial and not affiliated with Leboncoin.

Seller filters and price indications are browsing aids only. A **(Bon)** price does not guarantee that an item is legitimate, correctly described, or actually a good deal.

The script relies on undocumented internal API endpoints and frontend behavior observed through the browser. It may stop working if Leboncoin changes its API responses, search markup, pagination, or anti-bot protections.

Found a bug? Open an issue with the console output and the URL you were on.

## License

[MIT](LICENSE)
