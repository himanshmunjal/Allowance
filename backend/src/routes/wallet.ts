import { Hono } from "hono";
import { requireUser, type AppEnv } from "../http";
import { config } from "../lib/config";
import { audit, newId } from "../lib/db";
import { createPaymentToken, createSetupToken, deletePaymentToken, PayPalError } from "../lib/paypal";
import { getPendingSetupToken, getVaultId, getWallet, setWalletConnected, setWalletDisconnected, setWalletPending } from "../lib/wallet";

// Vault v3 "save PayPal without purchase" (LLD §6), per user (D-053). APP_URL is the frontend's public URL; it
// proxies /api/* here, so PayPal's redirect back lands on this router.

export const walletRoutes = new Hono<AppEnv>()
  .use("*", requireUser) // also /return: PayPal's redirect is a top-level GET, so the Lax cookie is sent
  .get("/", async (c) => c.json(await getWallet(c.var.user.id)))

  // Step 1: create a setup token and send the user to PayPal to approve it.
  .post("/connect", async (c) => {
    const appUrl = config.appUrl();
    let token;
    try {
      token = await createSetupToken(`${appUrl}/api/wallet/return`, `${appUrl}/?wallet=cancelled`, newId("setup"));
    } catch (err) {
      // Some sandbox apps get "save with purchase" but not the standalone Vault API (D-046).
      if (err instanceof PayPalError && err.name === "NOT_AUTHORIZED") {
        return c.json(
          {
            error:
              "Your PayPal app can't save a wallet on its own yet. Approve your next purchase with “Save my PayPal for auto-pay” ticked instead.",
          },
          409,
        );
      }
      throw err;
    }
    const approveUrl = token.links.find((l) => l.rel === "approve")?.href;
    if (!approveUrl) throw new Error("PayPal did not return an approval link for the setup token");
    await setWalletPending(c.var.user.id, token.id);
    await audit(c.var.user.id, "WALLET_CONNECT_STARTED", "Redirecting to PayPal to save your wallet for auto-pay", null, { setupTokenId: token.id });
    return c.json({ approveUrl });
  })

  // Step 2: PayPal redirects here after approval; exchange the setup token for a payment token.
  .get("/return", async (c) => {
    const appUrl = config.appUrl();
    const setupTokenId = c.req.query("approval_token_id") ?? c.req.query("token");
    if (!setupTokenId || setupTokenId !== (await getPendingSetupToken(c.var.user.id))) {
      return c.redirect(`${appUrl}/?wallet=error&reason=${encodeURIComponent("Unknown or expired PayPal approval")}`, 303);
    }
    try {
      const token = await createPaymentToken(setupTokenId);
      const email = token.payment_source?.paypal?.email_address ?? null;
      await setWalletConnected(c.var.user.id, token.id, token.customer?.id ?? null, email);
      await audit(c.var.user.id, "WALLET_CONNECTED", `PayPal wallet ${email ?? ""} saved: the agent can now auto-pay within your rules`, null, {
        customerId: token.customer?.id,
      });
      return c.redirect(`${appUrl}/?wallet=connected`, 303);
    } catch (err) {
      const reason = err instanceof PayPalError ? err.message : "Could not save the PayPal wallet";
      console.error("[wallet] payment token failed", err);
      await audit(c.var.user.id, "PAYPAL_ERROR", `Wallet connect failed: ${reason}`, null, { debugId: err instanceof PayPalError ? err.debugId : null });
      return c.redirect(`${appUrl}/?wallet=error&reason=${encodeURIComponent(reason)}`, 303);
    }
  })

  .delete("/", async (c) => {
    const vaultId = await getVaultId(c.var.user.id);
    if (vaultId) {
      // Best effort: revoke the token at PayPal too, but always disconnect locally.
      await deletePaymentToken(vaultId).catch((err) => console.warn("[wallet] could not delete payment token", err?.message));
    }
    await setWalletDisconnected(c.var.user.id);
    await audit(c.var.user.id, "WALLET_DISCONNECTED", "PayPal wallet disconnected: auto-pay is off");
    return c.json(await getWallet(c.var.user.id));
  });
