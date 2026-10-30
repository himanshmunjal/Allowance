// Checks every configured AI provider: one structured-JSON call and one tool call each.
// Run: npm run check-ai     (uses 2 requests per provider from your free quota)

import fs from "node:fs";
import { z } from "zod";
import { providerChain } from "../src/lib/llm";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const chain = (() => {
  try {
    return providerChain();
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
})();

console.log(`Provider order: ${chain.map((p) => `${p.label} (${p.model})`).join(" → ")}\n`);

let failures = 0;
for (const p of chain) {
  process.stdout.write(`${p.label.padEnd(7)} JSON output … `);
  try {
    const out = await p.json({
      name: "check",
      system: "You are a test endpoint.",
      user: 'Return {"ok": true, "word": "paypal"}.',
      schema: z.object({ ok: z.boolean(), word: z.string() }),
    });
    console.log(out.ok ? "✓" : "✗ unexpected output");
  } catch (err) {
    failures++;
    console.log(`✗ ${(err as Error).message}`);
  }

  process.stdout.write(`${p.label.padEnd(7)} tool calling … `);
  try {
    const out = await p.chat({
      system: "Always use the get_price tool to answer price questions.",
      tools: [
        {
          name: "get_price",
          description: "Get the price of a product",
          parameters: { type: "object", properties: { product: { type: "string" } }, required: ["product"] },
        },
      ],
      items: [{ role: "user", text: "What does coffee cost?" }],
    });
    const call = out.item.toolCalls[0];
    console.log(call?.name === "get_price" ? `✓ (${JSON.stringify(call.input)})` : "✗ the model answered without calling the tool");
    if (call?.name !== "get_price") failures++;
  } catch (err) {
    failures++;
    console.log(`✗ ${(err as Error).message}`);
  }
}
console.log(failures ? `\n${failures} check(s) failed. See the messages above.` : "\nAll AI providers work. Run: npm run dev");
process.exit(failures ? 1 : 0);
