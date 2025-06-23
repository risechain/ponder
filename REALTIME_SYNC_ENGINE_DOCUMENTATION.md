# Ponder Realtime Sync Engine: Complete Technical Documentation

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Core Sync Engine](#core-sync-engine)
3. [Realtime Sync Module](#realtime-sync-module)
4. [Historical Sync Module](#historical-sync-module)
5. [Database Architecture](#database-architecture)
6. [Event Processing Pipeline](#event-processing-pipeline)
7. [Advanced Features](#advanced-features)
8. [Performance Considerations](#performance-considerations)

## Architecture Overview

The Ponder realtime sync engine is a sophisticated blockchain data synchronization system designed to handle multiple chains concurrently while maintaining consistency through blockchain reorganizations. The architecture consists of several interconnected modules:

```
┌─────────────────────┐
│   Sync Orchestrator │ (packages/core/src/sync/index.ts)
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    │             │
┌───▼────┐   ┌───▼──────┐
│Historical│   │ Realtime │
│  Sync   │   │   Sync   │
└─────────┘   └──────────┘
    │             │
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │  Sync Store │ (Database Layer)
    └─────────────┘
```

### Key Design Principles

1. **Checkpoint-based Ordering**: All events are ordered using a deterministic checkpoint system that encodes timestamp, chain ID, block number, transaction index, event type, and event index.

2. **Reorg Safety**: The system maintains unfinalized blocks in memory and tracks all database operations with reorg tables for safe rollback.

3. **Multi-chain Support**: Supports two ordering modes:
   - **Multichain**: Each chain processes independently
   - **Omnichain**: Global ordering across all chains

4. **Performance Optimization**: Uses bloom filters, interval caching, and dynamic range estimation for efficient data fetching.

## Core Sync Engine

The main sync orchestrator (`packages/core/src/sync/index.ts`) coordinates between historical and realtime synchronization.

### Key Components

#### 1. Sync Type Definition
```typescript
export type Sync = {
  getEvents(): EventGenerator;
  startRealtime(): Promise<void>;
  getStartCheckpoint(chain: Chain): string;
  seconds: Seconds;
};
```

#### 2. Checkpoint System

The checkpoint system provides deterministic ordering across chains:

```typescript
// packages/core/src/utils/checkpoint.ts:1-8
export type Checkpoint = {
  blockTimestamp: bigint;
  chainId: bigint;
  blockNumber: bigint;
  transactionIndex: bigint;
  eventType: number;
  eventIndex: bigint;
};
```

Checkpoints are encoded as sortable strings:
- 10 digits for timestamp (supports until year 2277)
- 16 digits for chain ID
- 16 digits for block number
- 16 digits for transaction index
- 1 digit for event type
- 16 digits for event index

#### 3. Event Ordering

The sync engine supports two ordering modes:

**Multichain Ordering** (`packages/core/src/sync/index.ts:480-494`):
- Each chain processes events independently
- Events are emitted as soon as they're ready
- Better for applications that don't need cross-chain consistency

**Omnichain Ordering** (`packages/core/src/sync/index.ts:496`):
- Events are globally ordered across all chains
- Uses `mergeAsyncGeneratorsWithEventOrder` to maintain order
- Required for applications needing cross-chain consistency

### Event Flow

1. **Historical Phase**: Bulk fetches past data up to finalized block
2. **Realtime Phase**: Subscribes to new blocks and processes them
3. **Event Processing**: Decodes, filters, and orders events for indexing

## Realtime Sync Module

The realtime sync module (`packages/core/src/sync-realtime/index.ts`) handles live blockchain data synchronization.

### Core Functionality

#### 1. Block Reconciliation

The `reconcileBlock` function (`packages/core/src/sync-realtime/index.ts:864-1100`) handles four cases:

1. **Duplicate Block**: Already processed, skip
2. **Reorg Detection**: Block number decreased or parent hash mismatch
3. **Missing Blocks**: Fetch intermediate blocks
4. **Happy Path**: Process new block

#### 2. Reorg Detection and Recovery

```typescript
// packages/core/src/sync-realtime/index.ts:723-792
const reconcileReorg = async (block: SyncBlock | SyncBlockHeader) => {
  // Record blocks that have been removed from the local chain
  const reorgedBlocks = unfinalizedBlocks.filter(
    (lb) => hexToNumber(lb.number) >= hexToNumber(block.number),
  );
  
  // Walk back to find common ancestor
  let remoteBlock = block;
  while (true) {
    const parentBlock = getLatestUnfinalizedBlock();
    if (parentBlock.hash === remoteBlock.parentHash) break;
    // ... continue walking back
  }
  
  // Remove reorged data and emit reorg event
};
```

#### 3. Factory Contract Support

The system tracks addresses created by factory contracts:

```typescript
// packages/core/src/sync-realtime/index.ts:401-411
const blockChildAddresses = new Map<Factory, Set<Address>>();
for (const factory of factories) {
  blockChildAddresses.set(factory, new Set<Address>());
  for (const log of logs) {
    if (isLogFactoryMatched({ factory, log })) {
      const address = getChildAddress({ log, factory });
      blockChildAddresses.get(factory)!.add(address);
    }
  }
}
```

### Error Handling

The module implements exponential backoff with retry limits:

```typescript
// packages/core/src/sync-realtime/index.ts:135-137
const ERROR_TIMEOUT = [
  1, 2, 5, 10, 30, 60, 60, 60, 60, 60, 60, 60, 60, 60,
] as const;
```

## Historical Sync Module

The historical sync module (`packages/core/src/sync-historical/index.ts`) efficiently fetches past blockchain data.

### Key Features

#### 1. Dynamic Range Estimation

The system dynamically adjusts the number of blocks fetched per request:

```typescript
// packages/core/src/sync/index.ts:1555-1563
estimateRange = Math.min(
  Math.max(
    25,
    Math.round((1_000 * (interval[1] - interval[0])) / duration),
  ),
  estimateRange * 2,
  100_000,
);
```

#### 2. Interval Caching

Uses PostgreSQL's `nummultirange` type to track synced intervals:
- Avoids re-fetching already synced data
- Merges adjacent intervals for efficiency
- Supports partial sync recovery

#### 3. Request Optimization

- Splits large ranges into smaller chunks
- Uses bloom filters for pre-filtering
- Batches RPC requests for efficiency

## Database Architecture

The sync store uses PostgreSQL with sophisticated schema design for reorg safety.

### Core Tables

#### 1. Blockchain Data Tables
- `blocks`: Block headers and metadata
- `transactions`: Transaction data
- `transaction_receipts`: Receipt data including logs
- `logs`: Event logs
- `traces`: Execution traces

#### 2. Sync Management Tables
- `intervals`: Tracks synced block ranges using `nummultirange`
- `factories`: Factory contract configurations
- `factory_addresses`: Child addresses created by factories
- `rpc_request_results`: Caches RPC responses

### Reorg Safety Mechanism

Each user table has a corresponding reorg table:

```sql
CREATE TABLE "_reorg__${tableName}" (
  operation_id SERIAL PRIMARY KEY,
  operation INTEGER NOT NULL,  -- 0=INSERT, 1=UPDATE, 2=DELETE
  checkpoint VARCHAR(91) NOT NULL,
  -- ... original table columns ...
);
```

Operations are tracked with triggers:
- INSERT: Records new row in reorg table
- UPDATE: Records both old and new states
- DELETE: Records deleted row

### Crash Recovery

The system maintains safe checkpoints for recovery:

```typescript
// Get the last safe block before a crash
await syncStore.getSafeCrashRecoveryBlock({
  chainId: chain.id,
  timestamp: crashTimestamp,
});
```

## Event Processing Pipeline

### 1. Event Extraction

Events are extracted from blockchain data:

```typescript
// packages/core/src/sync/events.ts
export const buildEvents = ({
  sources,
  chainId,
  blockData,
  childAddresses,
}: {
  sources: Source[];
  chainId: number;
  blockData: BlockData;
  childAddresses: Map<Factory, Map<Address, number>>;
}) => {
  // Build raw events from logs, traces, transactions, etc.
};
```

### 2. Event Decoding

Raw events are decoded using contract ABIs:

```typescript
// packages/core/src/sync/index.ts:347-359
const decodedEvents = decodeEvents(
  params.common,
  sources,
  events,
);
```

### 3. Bloom Filter Optimization

Logs are pre-filtered using bloom filters:

```typescript
// packages/core/src/sync-realtime/index.ts:292-297
const shouldRequestLogs =
  maybeBlockHeader.logsBloom === zeroLogsBloom ||
  logFilters.some((filter) =>
    isFilterInBloom({ block: maybeBlockHeader, filter }),
  );
```

## Advanced Features

### 1. Multi-chain Synchronization

The engine supports synchronizing multiple chains concurrently:
- Independent sync progress per chain
- Coordinated checkpoints for omnichain mode
- Chain-specific finality depths

### 2. Finalization Tracking

```typescript
// packages/core/src/sync-realtime/index.ts:1006-1010
const blockMovesFinality =
  hexToNumber(block.number) >=
  hexToNumber(finalizedBlock.number) +
    2 * args.chain.finalityBlockCount;
```

### 3. Performance Metrics

The system tracks various performance metrics:
- `ponder_historical_extract_duration`: Time to extract events
- `ponder_realtime_latency`: Realtime processing latency
- `ponder_sync_block`: Current sync block per chain
- `ponder_historical_cached_blocks`: Number of cached blocks

### 4. Factory Address Discovery

Dynamically discovers and tracks addresses created by factory contracts:
- Monitors factory events for new addresses
- Maintains creation block numbers
- Efficiently filters events for factory children

## Performance Considerations

### 1. Optimization Strategies

- **Bloom Filters**: Skip RPC calls when logs don't match
- **Interval Caching**: Avoid re-fetching synced data
- **Batch Processing**: Process multiple blocks together
- **Dynamic Sizing**: Adjust request sizes based on performance

### 2. Scalability Features

- **Concurrent Chain Processing**: Each chain syncs independently
- **Efficient Storage**: Uses PostgreSQL-specific types
- **Request Deduplication**: Caches RPC results
- **Incremental Sync**: Resumes from last checkpoint

### 3. Resource Management

- **Memory Management**: Limits unfinalized blocks in memory
- **Connection Pooling**: Efficient database connections
- **Rate Limiting**: Respects RPC rate limits
- **Error Recovery**: Exponential backoff on failures

## Detailed Component Analysis

### 1. Block Fetching and Validation

The realtime sync module implements comprehensive block validation:

```typescript
// packages/core/src/sync-realtime/index.ts:279-532
const fetchBlockEventData = async (
  maybeBlockHeader: SyncBlock | SyncBlockHeader,
): Promise<BlockWithEventData> => {
  let block: SyncBlock | undefined;

  if (isSyncBlock(maybeBlockHeader)) {
    block = maybeBlockHeader;
  }

  ////////
  // Logs
  ////////

  // "eth_getLogs" calls can be skipped if no filters match `newHeadBlock.logsBloom`.
  const shouldRequestLogs =
    maybeBlockHeader.logsBloom === zeroLogsBloom ||
    logFilters.some((filter) =>
      isFilterInBloom({ block: maybeBlockHeader, filter }),
    );

  let logs: SyncLog[] = [];
  if (shouldRequestLogs) {
    if (block === undefined) {
      [block, logs] = await Promise.all([
        _eth_getBlockByHash(args.rpc, { hash: maybeBlockHeader.hash }),
        _eth_getLogs(args.rpc, { blockHash: maybeBlockHeader.hash }),
      ]);
    } else {
      logs = await _eth_getLogs(args.rpc, { blockHash: block.hash });
    }

    validateLogsAndBlock(logs, block);
  }
  
  // ... Additional validation and processing
};
```

### 2. Transaction Receipt Handling

The system optimizes transaction receipt fetching:

```typescript
// packages/core/src/sync-realtime/index.ts:214-264
const syncTransactionReceipts = async (
  block: SyncBlock,
  transactionHashes: Set<Hash>,
): Promise<SyncTransactionReceipt[]> => {
  if (transactionHashes.size === 0) {
    return [];
  }

  if (isBlockReceipts === false) {
    const transactionReceipts = await Promise.all(
      Array.from(transactionHashes).map(async (hash) =>
        _eth_getTransactionReceipt(args.rpc, { hash }),
      ),
    );

    validateReceiptsAndBlock(
      transactionReceipts,
      block,
      "eth_getTransactionReceipt",
    );

    return transactionReceipts;
  }

  let blockReceipts: SyncTransactionReceipt[];
  try {
    blockReceipts = await _eth_getBlockReceipts(args.rpc, {
      blockHash: block.hash,
    });
  } catch (_error) {
    // Fallback to individual receipt fetching
    isBlockReceipts = false;
    return syncTransactionReceipts(block, transactionHashes);
  }

  // Filter receipts to only required transactions
  const transactionReceipts = blockReceipts.filter((receipt) =>
    transactionHashes.has(receipt.transactionHash),
  );

  return transactionReceipts;
};
```

### 3. Sync Progress Tracking

The system tracks sync progress across multiple dimensions:

```typescript
// packages/core/src/sync/index.ts:109-114
export type SyncProgress = {
  start: SyncBlock | LightBlock;
  end: SyncBlock | LightBlock | undefined;
  current: SyncBlock | LightBlock | undefined;
  finalized: SyncBlock | LightBlock;
};
```

Progress is used for:
- Determining sync completion
- Calculating finalization status
- Reporting progress to users
- Managing realtime vs historical phases

### 4. Event Generator Implementation

The core event generator merges multiple chain streams:

```typescript
// packages/core/src/sync/index.ts:322-507
async function* getEvents() {
  const to = min(
    getOmnichainCheckpoint({ tag: "finalized" }),
    getOmnichainCheckpoint({ tag: "end" }),
  );

  const eventGenerators = await Promise.all(
    Array.from(perChainSync.entries()).map(
      async ([chain, { syncProgress, historicalSync }]) => {
        const sources = params.indexingBuild.sources.filter(
          ({ filter }) => filter.chainId === chain.id,
        );

        // Create chain-specific event generator
        const localEventGenerator = getLocalEventGenerator({
          common: params.common,
          chain,
          syncStore: params.syncStore,
          sources,
          localSyncGenerator,
          from,
          to,
          limit: Math.round(
            params.common.options.syncEventsQuerySize /
              (params.indexingBuild.chains.length + 1),
          ) + 6,
        });

        return sortCompletedAndPendingEvents(
          sortCrashRecoveryEvents(decodeEventGenerator(localEventGenerator)),
        );
      },
    ),
  );

  let eventGenerator: EventGenerator;
  if (params.ordering === "multichain") {
    eventGenerator = mapAsyncGenerator(
      mergeAsyncGenerators(eventGenerators),
      ({ events, checkpoint }) => ({
        events,
        checkpoints: [{
          chainId: Number(decodeCheckpoint(checkpoint).chainId),
          checkpoint,
        }],
      }),
    );
  } else {
    eventGenerator = mergeAsyncGeneratorsWithEventOrder(eventGenerators);
  }

  for await (const { events, checkpoints } of eventGenerator) {
    yield { events, checkpoints };
  }
}
```

### 5. Factory Address Management

The system maintains a sophisticated factory address tracking system:

```typescript
// packages/core/src/sync-realtime/index.ts:546-556
const filterBlockEventData = ({
  block,
  logs,
  traces,
  transactions,
  transactionReceipts,
  childAddresses: blockChildAddresses,
}: BlockWithEventData) => {
  // Update `childAddresses`
  for (const factory of factories) {
    for (const address of blockChildAddresses.get(factory)!) {
      if (childAddresses.get(factory)!.has(address) === false) {
        childAddresses.get(factory)!.set(address, hexToNumber(block.number));
      } else {
        blockChildAddresses.get(factory)!.delete(address);
      }
    }
  }

  // Save per block child addresses so that they can be undone in the event of a reorg.
  childAddressesPerBlock.set(hexToNumber(block.number), blockChildAddresses);
};
```

This ensures:
- Factory child addresses are tracked across blocks
- Reorgs properly revert factory address changes
- Efficient filtering of events for factory-created contracts

## Conclusion

The Ponder realtime sync engine represents a sophisticated approach to blockchain data synchronization. Its design prioritizes:

1. **Correctness**: Deterministic ordering and safe reorg handling
2. **Performance**: Multiple optimization strategies
3. **Reliability**: Comprehensive error handling and recovery
4. **Flexibility**: Support for multiple chains and ordering modes

The modular architecture allows for future enhancements while maintaining backward compatibility and operational stability. The system successfully handles the complexities of multi-chain synchronization, blockchain reorganizations, and high-performance data processing while providing a clean, developer-friendly interface.