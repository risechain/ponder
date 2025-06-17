# Ponder Block Reorganization Handling

## Overview

Blockchain reorganizations (reorgs) occur when a blockchain network switches to a different canonical chain, invalidating previously confirmed blocks and transactions. This can happen due to network splits, competing miners/validators, or temporary network partitions. For blockchain indexing applications like Ponder, handling reorgs correctly is critical to maintain data consistency and accuracy.

Ponder implements a sophisticated reorg detection and recovery system that can:
- Detect reorgs in real-time as new blocks arrive
- Automatically revert indexed data to the last common ancestor
- Re-process events from the new canonical chain
- Maintain perfect consistency with the blockchain state

## Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Blockchain    │    │  Sync Engine    │    │   Database      │
│                 │    │                 │    │                 │
│ Block N-1: AAA  │───▶│ Store Block     │───▶│ Main Tables     │
│ Block N:   BBB  │    │ Detect Reorg    │    │ Shadow Tables   │
│ Block N+1: CCC  │    │ Reconcile       │    │ Triggers        │
│      ↓          │    │      ↓          │    │      ↓          │
│ Block N:   XXX  │    │ Revert Events   │    │ Revert Data     │
│ Block N+1: YYY  │    │ Reschedule      │    │ Re-index        │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Reorg Detection Mechanisms

### 1. Real-time Block Validation (`sync-realtime/index.ts:886-936`)

Ponder detects reorgs through two validation checks in the `reconcileBlock` function:

#### a) Block Number Check
```typescript
if (hexToNumber(latestBlock.number) >= hexToNumber(block.number)) {
  await reconcileReorg(block);
  return { type: "rejected" };
}
```
**Trigger**: New block number ≤ latest stored block number  
**Indicates**: Out-of-order delivery or competing chain

#### b) Parent Hash Check
```typescript
if (block.parentHash !== latestBlock.hash) {
  await reconcileReorg(block);
  return { type: "rejected" };
}
```
**Trigger**: New block's parent hash ≠ latest stored block hash  
**Indicates**: Chain fork detected

### 2. Reorg Reconciliation Process

When a reorg is detected, the `reconcileReorg` function executes:

```typescript
const reconcileReorg = async (forkBlock: RpcBlock) => {
  const reorgedBlocks: ReorgedBlock[] = [];
  let currentBlock = latestBlock;
  
  // Walk backwards to find common ancestor
  while (currentBlock && currentBlock.hash !== forkBlock.parentHash) {
    reorgedBlocks.push({
      block: currentBlock,
      removedChildAddresses: new Set(),
    });
    currentBlock = unfinalizedBlocks.find(b => b.hash === currentBlock.parentHash);
  }
  
  if (!currentBlock) {
    // Deep reorg beyond finalized blocks - unrecoverable
    throw new Error("Reorg detected beyond finalized blocks");
  }
  
  // Emit reorg event with common ancestor
  emit("reorg", {
    checkpoint: encodeCheckpoint(currentBlock),
    reorgedBlocks,
  });
};
```

## Database Architecture for Reorg Handling

### 1. Shadow Table System

For every user table `users`, Ponder creates a shadow table `_reorg_users` with the structure:

```sql
CREATE TABLE "_reorg_users" (
  -- All columns from original table
  id TEXT,
  name TEXT,
  email TEXT,
  -- Reorg tracking columns
  operation_id SERIAL PRIMARY KEY,
  operation INTEGER NOT NULL, -- 0=insert, 1=update, 2=delete
  checkpoint TEXT NOT NULL
);
```

### 2. PostgreSQL Trigger System

Triggers capture all changes to user tables (`database/index.ts:1006-1032`):

```sql
CREATE OR REPLACE FUNCTION "public".users_reorg_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "public"."_reorg_users" (id, name, email, operation, checkpoint)
    VALUES (NEW.id, NEW.name, NEW.email, 0, '999999999999999~1~999999999');
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO "public"."_reorg_users" (id, name, email, operation, checkpoint)
    VALUES (OLD.id, OLD.name, OLD.email, 1, '999999999999999~1~999999999');
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO "public"."_reorg_users" (id, name, email, operation, checkpoint)
    VALUES (OLD.id, OLD.name, OLD.email, 2, '999999999999999~1~999999999');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "users_reorg_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "public"."users"
FOR EACH ROW EXECUTE FUNCTION "public".users_reorg_trigger();
```

**Key Points**:
- `MAX_CHECKPOINT_STRING` (`'999999999999999~1~999999999'`) ensures operations are captured before checkpoint updates
- `OLD` values are stored for updates and deletes to enable restoration
- `operation` codes: 0=insert, 1=update, 2=delete

### 3. Complex Revert Operation

The revert process uses a sophisticated multi-CTE SQL query (`database/index.ts:1093-1131`):

```sql
WITH reverted1 AS (
  -- Delete all operations after the reorg checkpoint
  DELETE FROM "public"."_reorg_users"
  WHERE checkpoint > '${checkpoint}' RETURNING *
), reverted2 AS (
  -- Find the earliest operation for each primary key
  SELECT "id", MIN(operation_id) AS operation_id FROM reverted1
  GROUP BY "id"
), reverted3 AS (
  -- Get the original values for restoration
  SELECT u.id, u.name, u.email, u.operation
  FROM reverted2 r2
  INNER JOIN reverted1 u ON r2."id" = u."id" AND r2.operation_id = u.operation_id
), inserted AS (
  -- Remove records that were inserted after checkpoint
  DELETE FROM "public"."users" as t
  WHERE EXISTS (
    SELECT * FROM reverted3
    WHERE t."id" = reverted3."id" AND operation = 0
  )
  RETURNING *
), updated_or_deleted AS (
  -- Restore records that were updated or deleted after checkpoint
  INSERT INTO "public"."users"
  SELECT "id", "name", "email" FROM reverted3
  WHERE operation = 1 OR operation = 2
  ON CONFLICT ("id")
  DO UPDATE SET
    "name" = EXCLUDED."name",
    "email" = EXCLUDED."email"
  RETURNING *
)
SELECT COUNT(*) FROM reverted1;
```

**Process**:
1. **reverted1**: Extract and delete all operations after reorg checkpoint
2. **reverted2**: Group by primary key, find earliest operation per record
3. **reverted3**: Join to get original values for restoration
4. **inserted**: Delete records that were inserted (operation = 0)
5. **updated_or_deleted**: Restore records to their pre-reorg state (operation = 1 or 2)

## Event Processing During Reorgs

### 1. Event Rescheduling (`sync/index.ts:714-788`)

When a reorg event is received, the sync engine:

```typescript
case "reorg": {
  const { reorgedEvents } = removeReorgedEvents({
    executedEvents,
    pendingEvents,
    checkpoint: event.checkpoint,
  });

  if (ordering === "multichain") {
    executedEvents.splice(0, reorgedEvents.executed);
    pendingEvents.unshift(...reorgedEvents.events);
  } else {
    // omnichain ordering
    currentCheckpoint = event.checkpoint;
    pendingEvents.push(...reorgedEvents.events);
    pendingEvents.sort(compareEvents);
  }
  
  common.logger.info({
    service: "sync",
    msg: `Rescheduled ${reorgedEvents.events.length} events due to reorg`,
  });
  break;
}
```

**Multichain Ordering**: Events maintain their original order, moved from executed back to pending
**Omnichain Ordering**: Events are re-sorted by checkpoint after rescheduling

### 2. Database Revert Process (`bin/utils/run.ts:559-571`)

The indexing engine handles reorg events by:

```typescript
case "reorg":
  await database.removeTriggers();           // Prevent new operations from being tracked
  await database.retry(async () => {
    await database.qb.drizzle.transaction(async (tx) => {
      await database.revert({ checkpoint: event.checkpoint, tx });
    });
  });
  await database.createTriggers();           // Re-enable operation tracking
  break;
```

**Atomicity**: The entire revert happens in a single database transaction
**Trigger Management**: Temporarily disable triggers to prevent tracking revert operations

## Checkpoint System

### 1. Checkpoint Encoding

Checkpoints encode blockchain state as strings: `${blockTimestamp}~${chainId}~${blockNumber}`

Example: `1672531200~1~16500000` (timestamp=1672531200, chainId=1, blockNumber=16500000)

### 2. Checkpoint Types

```typescript
type Checkpoint = {
  safeCheckpoint: string;    // Latest finalized checkpoint
  latestCheckpoint: string;  // Latest processed checkpoint (may be unfinalized)
};
```

**Safe Checkpoint**: Beyond finality depth, cannot be reorged
**Latest Checkpoint**: May be subject to reorgs

### 3. Finality Block Counts (`utils/finality.ts`)

Different networks have different finality requirements:

```typescript
export function getFinalityBlockCount({ chain }: { chain: Chain }) {
  switch (chain?.id) {
    case 1:    // Ethereum Mainnet
    case 11155111: // Sepolia
      return 65;
    case 137:  // Polygon
    case 80001: // Mumbai
      return 200;
    case 42161: // Arbitrum One
      return 240;
    default:
      return 30; // OP Stack chains (2-second blocks)
  }
}
```

## Safety Mechanisms

### 1. Deep Reorg Protection

If a reorg extends beyond finalized blocks, Ponder treats it as unrecoverable:

```typescript
if (!currentBlock) {
  const error = new NonRetryableError(
    "Detected forked block that is older than the finalized block"
  );
  throw error;
}
```

### 2. Unfinalized Block Tracking

The sync engine maintains an in-memory list of unfinalized blocks for reorg detection:

```typescript
const unfinalizedBlocks: Block[] = [];

// Add new blocks
unfinalizedBlocks.push(block);

// Remove finalized blocks
while (unfinalizedBlocks.length > finalityBlockCount) {
  const finalizedBlock = unfinalizedBlocks.shift()!;
  emit("finalize", { checkpoint: encodeCheckpoint(finalizedBlock) });
}
```

### 3. Finalization Process

When blocks become finalized, old reorg data is cleaned up:

```typescript
case "finalize":
  await database.qb.drizzle.update(database.PONDER_CHECKPOINT).set({
    safeCheckpoint: event.checkpoint,
  });
  
  await database.finalize({
    checkpoint: event.checkpoint,
    db: database.qb.drizzle,
  });
  break;
```

The `finalize` method removes old reorg tracking data:

```sql
DELETE FROM "_reorg_users" WHERE checkpoint <= '${finalizedCheckpoint}';
```

## Error Handling and Recovery

### 1. Reorg Event Types

```typescript
type ReorgEvent = {
  type: "reorg";
  checkpoint: string;        // Common ancestor checkpoint
  reorgedBlocks: ReorgedBlock[];
};

type ReorgedBlock = {
  block: Block;
  removedChildAddresses: Set<Address>; // Factory-created addresses to remove
};
```

### 2. Recovery Scenarios

**Shallow Reorgs** (< finality depth):
- Detected and handled automatically
- Data reverted to common ancestor
- Events rescheduled and re-processed

**Deep Reorgs** (≥ finality depth):
- Considered unrecoverable
- Application exits with fatal error
- Manual intervention required

**Network Partitions**:
- Temporary disconnections handled by retry logic
- Long partitions may trigger deep reorg protection

### 3. Logging and Observability

Reorg events are extensively logged:

```typescript
common.logger.warn({
  service: "realtime",
  msg: `Detected forked '${chain.name}' block at height ${hexToNumber(block.number)} (${block.hash})`,
});

common.logger.info({
  service: "sync", 
  msg: `Rescheduled ${reorgedEvents.events.length} events due to reorg (chain=${chain.name})`,
});

common.logger.info({
  service: "database",
  msg: `Reverted ${result.rows[0]!.count} unfinalized operations from '${tableName}'`,
});
```

## Performance Considerations

### 1. Memory Usage

- Unfinalized blocks are kept in memory (limited by finality depth)
- Reorg tables grow with activity but are pruned at finalization
- Event queues temporarily expand during rescheduling

### 2. Database Impact

- Triggers add minimal overhead to normal operations
- Revert operations can be expensive for large reorgs
- Shadow tables consume additional storage

### 3. Sync Performance

- Reorg detection is fast (hash comparisons)
- Recovery time proportional to reorg depth and affected data
- Network catch-up required after reorg resolution

## Example Reorg Scenario

### Initial State
```
Chain: A → B → C → D
Ponder State: [A, B, C, D] (all indexed)
```

### Reorg Detected
```
Chain: A → B → X → Y
Incoming Block: X (parent = B, but latest = D)
```

### Recovery Process
```
1. Detect: X.parentHash ≠ D.hash
2. Find Common Ancestor: B
3. Revert Database: Remove operations after checkpoint(B)
4. Reschedule Events: Move C, D events back to pending
5. Re-index: Process X, Y events
Final State: [A, B, X, Y]
```

## Conclusion

Ponder's reorg handling system provides robust protection against blockchain reorganizations through:

- **Real-time detection** via block validation
- **Comprehensive data tracking** using shadow tables and triggers
- **Atomic reversion** with complex SQL operations
- **Event rescheduling** maintaining proper ordering
- **Safety mechanisms** preventing unrecoverable scenarios

This architecture ensures that indexed data remains perfectly consistent with the canonical blockchain state, even in the face of complex network conditions and deep reorganizations.