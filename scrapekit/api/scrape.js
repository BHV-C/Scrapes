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


// ---- eBay official Browse API (free; needs EBAY_CLIENT_ID + EBAY_CLIENT_SECRET) ----
let ebayToken = { value: null, exp: 0 };
async function getEbayToken() {
  if (ebayToken.value && Date.now() < ebayToken.exp) return ebayToken.value;
  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  const d = await r.json();
  if (!r.ok) throw new Error("eBay auth failed: " + (d.error_description || r.status));
  ebayToken = { value: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return ebayToken.value;
}

async function ebayApi(target) {
  const token = await getEbayToken();
  const headers = { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" };
  const money = (m) => (m ? `${m.value} ${m.currency}` : "");
  const itm = target.pathname.match(/\/itm\/(?:[^/]+\/)?(\d{9,14})/);

  if (itm) {
    const r = await fetch(`https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${itm[1]}`, { headers });
    const d = await r.json();
    if (!r.ok) throw new Error("eBay API: " + (d.errors?.[0]?.message || r.status));
    return {
      pageTitle: d.title,
      rows: [{
        title: d.title, price: money(d.price), condition: d.condition || "",
        seller: d.seller?.username || "", location: d.itemLocation?.country || "",
        image: d.image?.imageUrl || "", link: d.itemWebUrl || target.href,
      }],
    };
  }

  const q = target.searchParams.get("_nkw");
  if (!q) throw new Error("Use an eBay item URL (/itm/...) or a search URL containing _nkw=");
  const r = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=50`, { headers });
  const d = await r.json();
  if (!r.ok) throw new Error("eBay API: " + (d.errors?.[0]?.message || r.status));
  return {
    pageTitle: `eBay search: ${q}`,
    rows: (d.itemSummaries || []).map((i) => ({
      title: i.title, price: money(i.price), condition: i.condition || "",
      seller: i.seller?.username || "", link: i.itemWebUrl,
    })),
  };
}

// ---- Generic product page: JSON-LD, then Open Graph fallback ----
function productFromHtml($, base) {
  let out = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (out) return;
    try {
      const j = JSON.parse($(el).contents().text());
      const nodes = [].concat(j, j["@graph"] || []);
      const p = nodes.find((n) => n && [].concat(n["@type"]).includes("Product"));
      if (p) {
        const o = [].concat(p.offers || [])[0] || {};
        out = {
          title: p.name || "",
          price: [o.price || o.lowPrice || "", o.priceCurrency || ""].join(" ").trim(),
          brand: (p.brand && (p.brand.name || p.brand)) || "",
          rating: p.aggregateRating ? `${p.aggregateRating.ratingValue} (${p.aggregateRating.reviewCount || p.aggregateRating.ratingCount || "?"})` : "",
          image: [].concat(p.image || [])[0]?.url || [].concat(p.image || [])[0] || "",
          link: base,
        };
      }
    } catch {}
  });
  if (out) return out;
  const og = (n) => $(`meta[property="${n}"]`).attr("content") || "";
  return {
    title: og("og:title") || $("title").text().trim(),
    price: og("product:price:amount") || og("og:price:amount"),
    image: og("og:image"),
    description: og("og:description"),
    link: base,
  };
}

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

    // eBay: prefer the official API when credentials are configured (eBay blocks cloud IPs).
    if (/(^|\.)ebay\.[a-z.]+$/i.test(target.hostname) && process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET) {
      const out = await ebayApi(target);
      return res.status(200).json({ count: out.rows.length, pageTitle: out.pageTitle, rows: out.rows });
    }

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
        error: `Site responded ${r.status}. It is blocking this server. For eBay, set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (free official API); for other sites, set SCRAPER_API_KEY.`,
      });
    }
    if (/captcha|robot check|unusual traffic/i.test(html.slice(0, 5000))) {
      return res.status(502).json({ error: "Blocked by a CAPTCHA page. Use a proxy service (SCRAPER_API_KEY)." });
    }

    const $ = cheerio.load(html);
    if (preset === "product") {
      const row = productFromHtml($, target.href);
      return res.status(200).json({ count: 1, pageTitle: $("title").first().text().trim(), rows: [row] });
    }
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
