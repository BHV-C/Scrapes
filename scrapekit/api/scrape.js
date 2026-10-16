const cheerio = require("cheerio");
const dns = require("dns").promises;
const net = require("net");

// Presets: CSS selectors change often. Edit here, or use "Custom" in the UI.
const PRESETS = {
  ebay: {
    item: "li.s-item, li.s-card",
    fields: {
      title: ".s-item__title, .s-card__title",
      price: ".s-item__price, .s-card__price",
      link: "a.s-item__link, a.s-card__link@href",
    },
  },
  amazon: {
    item: 'div[data-component-type="s-search-result"]',
    fields: {
      title: "h2 span",
      price: ".a-price .a-offscreen",
      rating: ".a-icon-alt",
      link: "a.a-link-normal.s-no-outline@href",
    },
  },
  etsy: {
    item: "li[data-listing-id], div.v2-listing-card",
    fields: {
      title: "h3, h2",
      price: ".currency-value",
      link: "a.listing-link@href",
    },
  },
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:127.") || l.startsWith("::ffff:10.") || l.startsWith("::ffff:192.168.");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Invalid URL"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http(s) URLs are allowed");
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("Private addresses are blocked");
  return u;
}

// "selector@attr" reads an attribute instead of text.
function extract($, el, spec, base) {
  const [sel, attr] = spec.split("@");
  const node = $(el).find(sel).first();
  if (!node.length) return "";
  if (attr) {
    const v = node.attr(attr) || "";
    try { return new URL(v, base).href; } catch { return v; }
  }
  return node.text().replace(/\s+/g, " ").trim();
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const { url, preset, itemSelector, fields } = req.body || {};
    const target = await assertPublicUrl(url);

    // Optional: set SCRAPER_API_KEY in Vercel to route through ScraperAPI
    // (helps with Amazon/Etsy blocking datacenter IPs).
    const key = process.env.SCRAPER_API_KEY;
    const fetchUrl = key
      ? `https://api.scraperapi.com/?api_key=${key}&url=${encodeURIComponent(target.href)}`
      : target.href;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(fetchUrl, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html" },
      signal: ctrl.signal,
      redirect: "follow",
    }).finally(() => clearTimeout(timer));

    const html = await r.text();
    if (!r.ok) {
      return res.status(502).json({
        error: `Site responded ${r.status}. It may be blocking the request; try a ScraperAPI key.`,
      });
    }
    if (/captcha|robot check|unusual traffic/i.test(html.slice(0, 5000))) {
      return res.status(502).json({ error: "Blocked by a CAPTCHA page. Use a proxy service (SCRAPER_API_KEY)." });
    }

    const $ = cheerio.load(html);
    const cfg = preset && PRESETS[preset] ? PRESETS[preset] : { item: itemSelector, fields };
    if (!cfg.item || !cfg.fields || !Object.keys(cfg.fields).length) {
      return res.status(400).json({ error: "Provide an item selector and at least one field." });
    }

    const rows = [];
    $(cfg.item).slice(0, 100).each((_, el) => {
      const row = {};
      for (const [name, spec] of Object.entries(cfg.fields)) row[name] = extract($, el, spec, target.href);
      if (Object.values(row).some(Boolean)) rows.push(row);
    });

    res.status(200).json({
      count: rows.length,
      pageTitle: $("title").first().text().trim(),
      rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.name === "AbortError" ? "Request timed out" : e.message });
  }
};
