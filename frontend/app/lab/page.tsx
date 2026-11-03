import type { Metadata } from "next";
import LabView from "./LabView";

export const metadata: Metadata = { title: "Attack Lab · Allowance" };

export default function LabPage() {
  return <LabView />;
}
