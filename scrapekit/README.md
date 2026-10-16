# Scrapekit

Static UI (`public/`) + one serverless function (`api/scrape.js`, Node + cheerio).

## Deploy on Vercel (free Hobby plan)
1. Push this folder to a GitHub repo.
2. vercel.com → Add New → Project → import the repo → Deploy. No build settings needed.
   (Or: `npm i -g vercel && vercel` from this folder.)
3. Optional: add env var `SCRAPER_API_KEY` (scraperapi.com free tier) so Amazon/Etsy requests go through a proxy.

## Run locally
    npm install
    npx vercel dev

## Customize
- Selectors for eBay/Amazon/Etsy live in `PRESETS` at the top of `api/scrape.js`. Sites change markup often; adjust there.
- Any other site: choose "Custom selectors" in the UI.
