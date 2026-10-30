import type { Metadata } from "next";
import { Suspense } from "react";
import LoginView from "./LoginView";

export const metadata: Metadata = { title: "Log in · Allowance" };

// useSearchParams (for ?next=) needs a Suspense boundary under Cache Components (D-017).
export default function LoginPage() {
  return (
    <Suspense>
      <LoginView />
    </Suspense>
  );
}
