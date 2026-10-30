import type { Metadata } from "next";
import StoreView from "./StoreView";

export const metadata: Metadata = { title: "Brew & Co. · demo store" };

export default function StorePage() {
  return <StoreView />;
}
