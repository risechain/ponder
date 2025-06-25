import { ponder } from "ponder:registry";
import { formatUnits } from "viem";

let lastRunTime = performance.now();

ponder.on("Usdc:Transfer", async ({ event }) => {
  const now = performance.now();
  console.log(
    `new Transfer: ${event.args.from} -> ${event.args.to}: ${formatUnits(event.args.value, 6)}`,
  );
  console.log(`shred interval: ${now - lastRunTime}ms`);
  lastRunTime = now;
});
