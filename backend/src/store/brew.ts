import type { Category } from "../shared/types";

// "Brew & Co.": a demo MERCHANT that accepts "Pay with Allowance" (D-060). It plays the part of a
// real online store: it owns its catalog and prices, creates a checkout quote for the order, and
// hands the shopper (or their AI agent) to Allowance to decide and pay.

export const STORE_NAME = "Brew & Co.";

export type StoreProduct = {
  id: string;
  name: string;
  description: string;
  price: number;
  category: Category;
  emoji: string;
  rating: number;
  deliveryDays: number;
};

export const storeProducts: StoreProduct[] = [
  { id: "bc_house_blend", name: "House Blend Beans (500g)", description: "Chocolatey medium roast, our bestseller.", price: 16, category: "coffee", emoji: "☕", rating: 4.8, deliveryDays: 2 },
  { id: "bc_single_origin", name: "Kenya AA Single Origin (500g)", description: "Bright, juicy, blackcurrant notes.", price: 34, category: "coffee", emoji: "🫘", rating: 4.9, deliveryDays: 2 },
  { id: "bc_mug", name: "Stoneware Mug", description: "Hand-glazed, 350 ml.", price: 18, category: "home", emoji: "🍵", rating: 4.7, deliveryDays: 3 },
  { id: "bc_gift_box", name: "Coffee Lover's Gift Box", description: "Two bags of beans, a mug and tasting notes, gift wrapped.", price: 59, category: "gifts", emoji: "🎁", rating: 4.8, deliveryDays: 3 },
  { id: "bc_grinder", name: "Electric Burr Grinder", description: "40 grind settings, quiet motor.", price: 129, category: "electronics", emoji: "⚙️", rating: 4.6, deliveryDays: 4 },
  { id: "bc_espresso", name: "Pro Espresso Machine", description: "Dual boiler, PID temperature control.", price: 999, category: "electronics", emoji: "🔥", rating: 4.7, deliveryDays: 5 },
];

export const getStoreProduct = (id: string) => storeProducts.find((p) => p.id === id);
