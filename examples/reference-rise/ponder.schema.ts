import { onchainTable } from "ponder-rise";

export const accounts = onchainTable("account", (t) => ({
  id: t.text().primaryKey(),
  transferIn: t.bigint().notNull(),
  transferOut: t.bigint().notNull(),
}));
