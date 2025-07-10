import { onchainTable } from "ponder-rise";

export const counter = onchainTable("counter", (t) => ({
  value: t.integer().primaryKey(),
  block: t.integer().notNull(),
}));
