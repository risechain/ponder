import { onchainTable } from "ponder-rise";

export const transactionEvents = onchainTable("transaction_events", (t) => ({
  to: t.hex().primaryKey(),
  value: t.bigint().notNull(),
  data: t.hex().notNull(),
}));
