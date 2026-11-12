import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AppEnv } from "../http";
import { AlertAddressError, getAlertSettings, sendTestAlert, setAlertUrl } from "../lib/notify";

// Approval alerts settings (D-075). Parents only. The saved URL is never sent back: hook URLs carry a secret.

const Body = z.object({ url: z.string().trim().max(600).nullable() });
const lastTest = new Map<string, number>();

export const notifyRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .get("/", async (c) => c.json(await getAlertSettings(c.var.user.id)))
  .put("/", async (c) => {
    const { url } = Body.parse(await c.req.json());
    try {
      await setAlertUrl(c.var.user.id, url ? url : null);
    } catch (err) {
      if (err instanceof AlertAddressError) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json(await getAlertSettings(c.var.user.id));
  })
  .post("/test", async (c) => {
    const now = Date.now();
    if (now - (lastTest.get(c.var.user.id) ?? 0) < 5000) return c.json({ ok: false, message: "One test at a time: try again in a few seconds." }, 429);
    lastTest.set(c.var.user.id, now);
    return c.json(await sendTestAlert(c.var.user.id));
  });
