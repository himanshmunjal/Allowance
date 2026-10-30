import type { Category } from "../shared/types";
import { config } from "./config";
import type { Merchant, Product } from "./catalog";

// Live product source: the Channel3 product search API (DECISION.md D-050).
// Docs: https://channel3.ai/docs/api-reference/v1/search
// Channel3 products are mapped onto the same Product/Merchant shapes as the demo catalog, so the
// rest of the pipeline (rules, injection screen, AI risk check, PayPal) doesn't know the difference.

const BASE_URL = "https://api.trychannel3.com/v1";
const TIMEOUT_MS = 8000;

/** Our ids for Channel3 products: "c3_<channel3 id>", so we always know where an id came from. */
export const ID_PREFIX = "c3_";

export class Channel3Error extends Error {}

type C3Price = { price: number; compare_at_price?: number | null; currency: string };
type C3Offer = { url: string; domain: string; price: C3Price; availability: string };
type C3Product = {
  id: string;
  title: string;
  description?: string | null;
  brands?: { id: string; name: string }[];
  category?: { slug: string; title: string; path?: { slug: string; title: string }[] } | null;
  offers?: C3Offer[];
  ratings?: { value: number; count: number } | null;
  images?: { url: string; is_main_image?: boolean }[];
};

async function request<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  const apiKey = config.channel3.apiKey();
  if (!apiKey) throw new Channel3Error("CHANNEL3_API_KEY is not set");
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${route}`, {
      method,
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Channel3Error(`Channel3 unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403 ? " (check CHANNEL3_API_KEY)" : res.status === 402 ? " (free credits used up)" : "";
    throw new Channel3Error(`Channel3 ${method} ${route} → HTTP ${res.status}${hint}`);
  }
  return (await res.json()) as T;
}

export type LiveItem = { product: Product; merchant: Merchant };

export async function searchLive(opts: { query: string; maxPrice?: number; limit?: number }): Promise<LiveItem[]> {
  const res = await request<{ products: C3Product[] }>("POST", "/search", {
    query: opts.query,
    limit: Math.min(opts.limit ?? 8, 30),
    ...(opts.maxPrice !== undefined && { filters: { price: { max_price: opts.maxPrice } } }),
  });
  return res.products.map(toItem).filter((i): i is LiveItem => i !== null);
}

/** Fresh fetch by our id ("c3_..."): used at purchase time, so the price is re-verified (D-005). */
export async function getLive(id: string): Promise<LiveItem | null> {
  const c3Id = id.slice(ID_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(c3Id)) return null;
  return toItem(await request<C3Product>("GET", `/products/${encodeURIComponent(c3Id)}`));
}

// The offer we would buy: the cheapest in-stock USD offer. Same rule at search and purchase time.
function bestOffer(p: C3Product): C3Offer | undefined {
  return (p.offers ?? [])
    .filter((o) => o.availability === "InStock" && o.price?.currency === "USD" && o.price.price > 0)
    .sort((a, b) => a.price.price - b.price.price)[0];
}

function toItem(p: C3Product): LiveItem | null {
  const offer = bestOffer(p);
  if (!offer) return null;
  const domain = offer.domain.toLowerCase();
  const category = mapCategory(p);
  const brand = p.brands?.[0]?.name;
  return {
    merchant: {
      id: `c3m_${domain}`,
      name: domain,
      // Channel3 indexes real retailer storefronts, so they count as verified sellers. The
      // injection screen and AI risk check still run on every listing (D-050).
      verified: true,
      blurb: "Retailer found through Channel3",
    },
    product: {
      id: `${ID_PREFIX}${p.id}`,
      merchantId: `c3m_${domain}`,
      name: (brand && !p.title.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${p.title}` : p.title).slice(0, 160),
      description: (p.description ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
      price: Math.round(offer.price.price * 100) / 100,
      category,
      rating: p.ratings?.value ? Math.round(p.ratings.value * 10) / 10 : null,
      deliveryDays: null,
      emoji: EMOJI[category],
      source: "channel3",
      url: offer.url,
      imageUrl: (p.images?.find((i) => i.is_main_image) ?? p.images?.[0])?.url,
    },
  };
}

// Map Channel3's category tree onto Allowance's rule categories, so "always ask: electronics" or
// "block gambling" still apply to live products. Unknown → "other".
const CATEGORY_KEYWORDS: [Category, RegExp][] = [
  ["gambling", /gambl|casino|lotter|betting/],
  ["coffee", /coffee|espresso|tea\b/],
  ["electronics", /electronic|computer|phone|audio|headphone|camera|video game|tv|television|charger|cable/],
  ["books", /book|magazine/],
  ["clothing", /cloth|apparel|shoe|footwear|sock|shirt|dress|jacket|fashion|accessor/],
  ["groceries", /grocer|food|beverage|snack|pantry/],
  ["gifts", /gift|party|celebration/],
  ["home", /home|kitchen|furniture|garden|decor|bed|bath|household|lighting/],
];

function mapCategory(p: C3Product): Category {
  const text = [p.category?.title, ...(p.category?.path ?? []).map((c) => c.title), p.category?.slug]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return CATEGORY_KEYWORDS.find(([, re]) => re.test(text))?.[0] ?? "other";
}

const EMOJI: Record<Category, string> = {
  coffee: "☕",
  groceries: "🧺",
  gifts: "🎁",
  electronics: "🔌",
  books: "📚",
  clothing: "👕",
  home: "🏠",
  gambling: "🎰",
  other: "🛍️",
};
