import { ponder } from "ponder:registry";
import { accounts } from "../ponder.schema";

ponder.on("Usdc:Transfer", async ({ event, context }) => {
  await context.db
    .insert(accounts)
    .values([
      {
        id: event.args.from,
        transferIn: 0n,
        transferOut: event.args.value,
      },
      {
        id: event.args.to,
        transferIn: event.args.value,
        transferOut: 0n,
      },
    ])
    .onConflictDoUpdate((row) =>
      row.id === event.args.from
        ? { transferOut: row.transferOut + event.args.value }
        : { transferIn: row.transferIn + event.args.value },
    );
});
