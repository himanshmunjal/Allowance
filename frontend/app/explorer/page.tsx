import type { Metadata } from "next";
import ExplorerView from "./ExplorerView";

export const metadata: Metadata = { title: "Spending Explorer · Allowance" };

export default function ExplorerPage() {
  return <ExplorerView />;
}
