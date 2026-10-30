import { z } from "zod";
import type { AgentContext } from "../lib/agents";
import { spendingStatus } from "../lib/agent";
import { searchCatalog } from "../lib/catalog";
import { listTransactions } from "../lib/db";
import { requestPurchase, withdrawPurchase } from "../lib/purchase";
import type { AllowanceOps } from "./tools";

// What an external agent can do, bound to that agent (D-054, D-057). Used by the REST API
// (/api/agent/*) and the remote MCP endpoint (/mcp), so both behave identically.

const SearchInput = z.object({ query: z.string().default(""), maxPrice: z.number().optional(), category: z.string().optional() });
const PurchaseInput = z.object({
  productId: z.string(),
  quantity: z.number().int().default(1),
  intent: z.string().trim().min(3).max(1000),
  reason: z.string().trim().min(3).max(1000),
});

export function agentOps(agent: AgentContext): AllowanceOps {
  return {
    search: async (input) => ({ products: await searchCatalog(SearchInput.parse(input)) }),
    status: () => spendingStatus(agent),
    purchase: async (input) => {
      const body = PurchaseInput.parse(input);
      return requestPurchase({
        agent,
        productId: body.productId,
        quantity: body.quantity,
        userIntent: body.intent,
        agentReason: body.reason,
        source: "mcp",
      });
    },
    withdraw: async (transactionId) => {
      const tx = await withdrawPurchase(agent, transactionId);
      return { id: tx.id, status: tx.status };
    },
    // Only this agent's own purchases: an agent can't see what the user's other agents bought.
    transactions: async () => ({
      transactions: (await listTransactions(agent.userId, 20, agent.id)).map((t) => ({
        id: t.id,
        status: t.status,
        item: t.title,
        amount: t.amount,
        merchant: t.merchantName,
        reasons: t.decisionReasons,
        createdAt: t.createdAt,
      })),
    }),
  };
}
