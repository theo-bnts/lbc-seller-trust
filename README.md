# LBC Seller-Trust Filter

A Tampermonkey userscript that filters Leboncoin search results based on seller trust
signals.

## Why

Some sellers on Leboncoin use newly-created accounts, have very little feedback, or have
poor ratings. Checking this manually means opening each seller profile one by one while
browsing search results.

This script does those checks automatically for every ad and hides listings that do not
meet the configured trust criteria.

It also removes sponsored and other non-listing blocks inserted between regular search
results.

## What it does

On `leboncoin.fr` search pages, each ad card's seller is checked against three signals:

- **Account age** — seller must have been registered for at least a configurable number
  of months (default 6).
- **Seller rating** — seller must have a rating of at least **4.5 / 5**.
- **Review count** — seller must have received at least **3 reviews**.

If any of these checks fail, the entire ad is hidden from the search results.

The script also hides non-listing elements inserted into the results list, including
sponsored blocks, video ads, empty placeholders, and similar promotional content.

No badges or additional information are added to visible ads.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the raw script and Tampermonkey will prompt to install it:
   `https://github.com/gushmazuko/lbc-seller-trust/raw/main/src/lbc-seller-trust.user.js`

## Configuration

One setting is editable via the Tampermonkey menu on the script:

| Setting                     | Range | Default |
| --------------------------- | ----- | ------- |
| Set age threshold (months)… | 1–36  | 6       |

Changing the age threshold reloads the page so all visible listings are evaluated again.

The rating and review thresholds are currently defined directly in the script:

| Setting        | Default |
| -------------- | ------- |
| Minimum rating | 4.5 / 5 |
| Minimum reviews | 3      |

## How it works

For each ad, the script first resolves the seller through Leboncoin's internal
`/finder/classified/` endpoint.

It then fetches the seller profile through the internal `user-card` API and reads:

- `registered_at`
- `feedback.overall_score`
- `feedback.received_count`

Leboncoin's `overall_score` value is normalized from `0` to `1`, so the script converts
it to a 5-star rating before applying the minimum rating threshold.

Seller profile lookups and classified lookups are cached in memory for the current page
session to avoid repeating the same API requests unnecessarily.

Listings are hidden when:

- the seller account is too recent;
- the seller has fewer than 3 reviews;
- the seller rating is below 4.5 / 5;
- or the seller rating is unavailable.

If an API request fails, the script fails open and leaves the listing visible.

The script also removes `<li>` elements inside the search results that do not contain a
normal `/ad/` listing link. This removes sponsored content and prevents empty gaps from
remaining between visible ads.

Full behavioral specification: [docs/SPEC.md](docs/SPEC.md).

## Limitations

- Only active on `leboncoin.fr/recherche*` search pages — not ad detail pages, profiles,
  favorites, or messaging.
- No options page or popup — configuration is menu-only.
- Rating and review thresholds are currently hard-coded.
- Trust verdicts and API responses are cached in memory for the page session only;
  nothing persists across reloads.
- The script relies on undocumented Leboncoin internal APIs and DOM structure, which may
  change without notice.

## Disclaimer

Unofficial and not affiliated with Leboncoin.

The script relies on undocumented internal API endpoints and frontend behavior observed
through the browser. It may stop working if Leboncoin changes its API responses, search
result markup, or anti-bot protections.

Found a bug? Open an issue with the console output and the URL you were on.

## License

[MIT](LICENSE)
