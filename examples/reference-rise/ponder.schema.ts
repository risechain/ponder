import { onchainTable } from "ponder";

export const accounts = onchainTable("account", (t) => ({
  id: t.text().primaryKey(),
  transferIn: t.bigint().notNull(),
  transferOut: t.bigint().notNull(),
}));
