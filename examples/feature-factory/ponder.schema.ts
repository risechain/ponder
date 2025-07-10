import { onchainTable } from "ponder-rise";

export const llama = onchainTable("llama", (t) => ({
  id: t.text().primaryKey(),
}));
