# Ponder createRpc Function: Complete Technical Documentation

## Overview

The `createRpc` function in Ponder is a sophisticated RPC (Remote Procedure Call) client factory that creates highly optimized, fault-tolerant connections to blockchain nodes. It implements advanced features like intelligent load balancing, adaptive rate limiting, automatic failover, and both HTTP/WebSocket support for maximum performance and reliability.

## Function Signature

```typescript
export const createRpc = ({
  common,
  chain,
  concurrency = 25,
}: { 
  common: Common; 
  chain: Chain; 
  concurrency?: number 
}): Rpc
```

## Core Architecture

### 1. Multi-Transport Support

The function supports multiple transport protocols and configurations:

```typescript
// Single RPC endpoint (string)
chain.rpc = "https://mainnet.infura.io/v3/YOUR-PROJECT-ID"

// Multiple RPC endpoints (array)
chain.rpc = [
  "https://mainnet.infura.io/v3/YOUR-PROJECT-ID",
  "https://eth-mainnet.alchemyapi.io/v2/YOUR-API-KEY",
  "https://cloudflare-eth.com"
]

// Custom transport function
chain.rpc = (config) => customTransport(config)
```

### 2. Protocol Detection and Transport Creation

The function automatically detects protocols and creates appropriate transports:

```typescript
if (typeof chain.rpc === "string") {
  const protocol = new url.URL(chain.rpc).protocol;
  if (protocol === "https:" || protocol === "http:") {
    request = [
      http(chain.rpc)({
        chain: chain.viemChain,
        retryCount: 0,
        timeout: 5_000,
      }).request,
    ];
  } else if (protocol === "wss:" || protocol === "ws:") {
    request = [
      webSocket(chain.rpc)({
        chain: chain.viemChain,
        retryCount: 0,
        timeout: 5_000,
      }).request,
    ];
  }
}
```

### 3. WebSocket Subscription Support

Separate WebSocket transport for real-time subscriptions:

```typescript
let wsTransport: ReturnType<WebSocketTransport> | undefined = undefined;

if (typeof chain.ws === "string") {
  const protocol = new url.URL(chain.ws).protocol;
  if (protocol === "wss:" || protocol === "ws:") {
    wsTransport = webSocket(chain.ws, { 
      keepAlive: true, 
      reconnect: false 
    })({
      chain: chain.viemChain,
      retryCount: 0,
      timeout: 5_000,
    });
  }
}
```

## Bucket System: Intelligent Load Balancing

### Bucket Structure

Each RPC endpoint is wrapped in a "bucket" that tracks performance metrics:

```typescript
type Bucket = {
  index: number;
  reactivationDelay: number;        // Exponential backoff delay
  activeConnections: number;        // Current active requests
  isActive: boolean;               // Whether bucket can receive requests
  isWarmingUp: boolean;           // Recently reactivated bucket
  
  latencyMetadata: {
    latencies: { value: number; success: boolean }[];
    successfulLatencies: number;
    latencySum: number;
  };
  expectedLatency: number;        // Calculated average latency
  
  requestTimestamps: number[];    // Recent request times for RPS calculation
  consecutiveSuccessfulRequests: number;
  rpsLimit: number;              // Dynamic rate limit
  
  request: EIP1193RequestFn;     // Actual transport request function
};
```

### Bucket Selection Algorithm

The `getBucket` function implements intelligent endpoint selection:

```typescript
const getBucket = async (): Promise<Bucket> => {
  const availableBuckets = buckets.filter((b) => isAvailable(b));

  if (availableBuckets.length === 0) {
    await wait(10);
    return getBucket(); // Recursive wait until bucket available
  }

  // Epsilon-greedy exploration (10% random selection)
  if (Math.random() < EPSILON) {
    const randomBucket = 
      availableBuckets[Math.floor(Math.random() * availableBuckets.length)]!;
    randomBucket.activeConnections++;
    return randomBucket;
  }

  // Select fastest bucket with load balancing
  const fastestBucket = availableBuckets.reduce((fastest, current) => {
    const currentLatency = current.expectedLatency;
    const fastestLatency = fastest.expectedLatency;

    // Switch if significantly faster (10% hurdle rate)
    if (currentLatency < fastestLatency * (1 - LATENCY_HURDLE_RATE)) {
      return current;
    }

    // Prefer less loaded bucket if latencies are similar
    if (
      currentLatency <= fastestLatency &&
      current.activeConnections < fastest.activeConnections
    ) {
      return current;
    }

    return fastest;
  }, availableBuckets[0]!);

  fastestBucket.activeConnections++;
  return fastestBucket;
};
```

## Dynamic Rate Limiting

### Request Rate Calculation

Each bucket tracks its request rate over a sliding 5-second window:

```typescript
const addRequestTimestamp = (bucket: Bucket) => {
  const timestamp = Date.now() / 1000;
  bucket.requestTimestamps.push(timestamp);
  
  // Remove timestamps older than 5 seconds
  while (timestamp - bucket.requestTimestamps[0]! > 5) {
    bucket.requestTimestamps.shift()!;
  }
};

const getRPS = (bucket: Bucket) => {
  const timestamp = Date.now() / 1000;
  
  // Clean old timestamps
  while (
    bucket.requestTimestamps.length > 0 &&
    timestamp - bucket.requestTimestamps[0]! > 5
  ) {
    bucket.requestTimestamps.shift()!;
  }

  if (bucket.requestTimestamps.length === 0) return 0;

  const timeSpan = 
    bucket.requestTimestamps[bucket.requestTimestamps.length - 1]! -
    bucket.requestTimestamps[0]! + 1;
    
  return bucket.requestTimestamps.length / timeSpan;
};
```

### Adaptive Rate Limit Adjustment

Rate limits automatically adjust based on performance:

```typescript
const increaseMaxRPS = (bucket: Bucket) => {
  if (
    bucket.consecutiveSuccessfulRequests >= SUCCESS_WINDOW_SIZE &&
    getRPS(bucket) > bucket.rpsLimit * RPS_INCREASE_QUALIFIER
  ) {
    const newRPSLimit = Math.min(
      bucket.rpsLimit * RPS_INCREASE_FACTOR, // 1.2x increase
      MAX_RPS, // Cap at 500 RPS
    );
    bucket.rpsLimit = newRPSLimit;
    bucket.consecutiveSuccessfulRequests = 0;
  }
};

const decreaseMaxRPS = (bucket: Bucket) => {
  const newRPSLimit = Math.max(
    bucket.rpsLimit * RPS_DECREASE_FACTOR, // 0.7x decrease
    MIN_RPS // Floor at 1 RPS
  );
  bucket.rpsLimit = newRPSLimit;
  bucket.consecutiveSuccessfulRequests = 0;
};
```

## Latency Tracking and Performance Optimization

### Rolling Latency Window

Each bucket maintains a rolling window of latency measurements:

```typescript
const addLatency = (bucket: Bucket, latency: number, success: boolean) => {
  bucket.latencyMetadata.latencies.push({ value: latency, success });
  bucket.latencyMetadata.latencySum += latency;
  
  if (success) {
    bucket.latencyMetadata.successfulLatencies++;
  }

  // Maintain fixed window size (500 measurements)
  if (bucket.latencyMetadata.latencies.length > LATENCY_WINDOW_SIZE) {
    const record = bucket.latencyMetadata.latencies.shift()!;
    bucket.latencyMetadata.latencySum -= record.value;
    if (record.success) {
      bucket.latencyMetadata.successfulLatencies--;
    }
  }

  // Calculate expected latency from successful requests only
  bucket.expectedLatency =
    bucket.latencyMetadata.latencySum /
    bucket.latencyMetadata.successfulLatencies;
};
```

## Request Queue and Concurrency Control

### Queue-Based Request Processing

All requests go through a concurrency-controlled queue:

```typescript
const queue = createQueue<
  Awaited<ReturnType<Rpc["request"]>>,
  Parameters<Rpc["request"]>[0]
>({
  initialStart: true,
  concurrency, // Default: 25 concurrent requests
  worker: async (body) => {
    // Request processing logic
  },
});
```

### Request Processing with Retry Logic

The worker function implements sophisticated retry logic:

```typescript
worker: async (body) => {
  for (let i = 0; i <= RETRY_COUNT; i++) { // Up to 9 retries
    const bucket = await getBucket();
    const stopClock = startClock();
    
    try {
      addRequestTimestamp(bucket);
      const response = await bucket.request(body);
      
      if (response === undefined) {
        throw new Error("Response is undefined");
      }

      const duration = stopClock();
      
      // Log successful request
      common.logger.trace({
        service: "rpc",
        msg: `Received '${chain.name}' ${body.method} response (duration=${duration})`,
      });
      
      // Update metrics and bucket state
      common.metrics.ponder_rpc_request_duration.observe(
        { method: body.method, chain: chain.name },
        duration,
      );
      
      addLatency(bucket, duration, true);
      bucket.consecutiveSuccessfulRequests++;
      increaseMaxRPS(bucket);
      
      // Reset bucket state after success
      bucket.isWarmingUp = false;
      bucket.reactivationDelay = INITIAL_REACTIVATION_DELAY;

      return response;
      
    } catch (e) {
      const error = e as Error;
      
      // Handle specific error types
      if (error.code === 429 || error.status === 429 || error instanceof TimeoutError) {
        if (bucket.isActive) {
          bucket.isActive = false;
          bucket.isWarmingUp = false;
          decreaseMaxRPS(bucket);
          scheduleBucketActivation(bucket);
          
          // Exponential backoff for rate limits, constant for timeouts
          bucket.reactivationDelay = error instanceof TimeoutError
            ? INITIAL_REACTIVATION_DELAY
            : Math.min(
                bucket.reactivationDelay * BACKOFF_FACTOR,
                MAX_REACTIVATION_DELAY,
              );
        }
      }
      
      addLatency(bucket, stopClock(), false);
      
      // Check if error is retryable
      if (shouldRetry(error) === false || i === RETRY_COUNT) {
        common.logger.warn({
          service: "rpc",
          msg: `Failed '${chain.name}' ${body.method} request after ${i + 1} attempts`,
          error,
        });
        throw error;
      }
      
      // Exponential backoff between retries
      const duration = BASE_DURATION * 2 ** i; // 125ms * 2^attempt
      await wait(duration);
      
    } finally {
      bucket.activeConnections--;
    }
  }
}
```

## Error Handling and Failover

### Bucket Deactivation and Reactivation

When a bucket encounters rate limiting or timeouts, it's temporarily deactivated:

```typescript
const scheduleBucketActivation = (bucket: Bucket) => {
  const timeoutId = setTimeout(() => {
    bucket.isActive = true;
    bucket.isWarmingUp = true;
    timeouts.delete(timeoutId);
    
    common.logger.debug({
      service: "rpc",
      msg: `RPC bucket ${bucket.index} reactivated for chain '${chain.name}' after ${Math.round(bucket.reactivationDelay)}ms`,
    });
  }, bucket.reactivationDelay);

  common.logger.debug({
    service: "rpc",
    msg: `RPC bucket '${chain.name}' ${bucket.index} deactivated. Reactivation scheduled in ${Math.round(bucket.reactivationDelay)}ms`,
  });

  timeouts.add(timeoutId);
};
```

### Special Handling for eth_getLogs

Special retry logic for `eth_getLogs` calls that may fail due to block range issues:

```typescript
if (
  body.method === "eth_getLogs" &&
  isHex(body.params[0].fromBlock) &&
  isHex(body.params[0].toBlock)
) {
  const getLogsErrorResponse = getLogsRetryHelper({
    params: body.params as GetLogsRetryHelperParameters["params"],
    error: error as RpcError,
  });

  if (getLogsErrorResponse.shouldRetry === true) throw error;
}
```

## WebSocket Subscription System

### Real-time Block Subscriptions

The RPC client supports both WebSocket subscriptions and polling fallback:

```typescript
async subscribe({ onBlock, onError, polling = false }) {
  if (polling || wsTransport === undefined) {
    // Fallback to polling mode
    interval = setInterval(() => {
      _eth_getBlockByNumber(rpc, { blockTag: "latest" })
        .then(onBlock)
        .catch(onError);
    }, chain.pollingInterval);
    
    return;
  }

  // WebSocket subscription with automatic fallback
  for (let i = 0; i <= RETRY_COUNT; ++i) {
    try {
      await wsTransport.value!.subscribe({
        params: ["newHeads"],
        onData: async (data) => {
          if (data.error === undefined && data.result !== undefined) {
            onBlock(data.result);
            webSocketErrorCount = 0; // Reset error count on success
          } else {
            webSocketErrorCount += 1;
            
            // Switch to polling after too many errors
            if (webSocketErrorCount === RETRY_COUNT) {
              await disconnect();
              rpc.subscribe({ onBlock, onError, polling: true });
            }
          }
        },
        onError: async (_error) => {
          webSocketErrorCount += 1;
          
          if (webSocketErrorCount === RETRY_COUNT) {
            // Switch to polling mode
            await disconnect();
            rpc.subscribe({ onBlock, onError, polling: true });
          } else {
            // Reconnect WebSocket
            await disconnect();
            rpc.subscribe({ onBlock, onError, polling: false });
          }
        },
      });
      
      return;
    } catch (_error) {
      if (i === RETRY_COUNT) {
        // Final fallback to polling
        rpc.subscribe({ onBlock, onError, polling: true });
        return;
      }
      
      const duration = BASE_DURATION * 2 ** i;
      await wait(duration);
    }
  }
}
```

## Configuration Constants

The function uses carefully tuned constants for optimal performance:

```typescript
const RETRY_COUNT = 9;                    // Maximum retries per request
const BASE_DURATION = 125;                // Base retry delay (ms)
const INITIAL_REACTIVATION_DELAY = 100;   // Initial bucket reactivation delay
const MAX_REACTIVATION_DELAY = 5_000;     // Maximum bucket reactivation delay
const BACKOFF_FACTOR = 1.5;               // Exponential backoff multiplier
const LATENCY_WINDOW_SIZE = 500;          // Rolling latency window size
const LATENCY_HURDLE_RATE = 0.1;          // 10% improvement needed to switch buckets
const EPSILON = 0.1;                      // 10% exploration rate for bucket selection
const INITIAL_MAX_RPS = 20;               // Starting RPS limit
const MIN_RPS = 1;                        // Minimum RPS limit
const MAX_RPS = 500;                      // Maximum RPS limit
const RPS_INCREASE_FACTOR = 1.2;          // RPS increase multiplier
const RPS_DECREASE_FACTOR = 0.7;          // RPS decrease multiplier
const RPS_INCREASE_QUALIFIER = 0.8;       // Threshold for RPS increase
const SUCCESS_WINDOW_SIZE = 100;          // Consecutive successes needed for RPS increase
```

## Return Value: Rpc Interface

The function returns an `Rpc` object with three main methods:

```typescript
export type Rpc = {
  request: <TParameters extends EIP1193Parameters<Schema>>(
    parameters: TParameters,
  ) => Promise<RequestReturnType<TParameters["method"]>>;
  
  subscribe: (params: {
    onBlock: (block: SyncBlock | SyncBlockHeader) => ReturnType<RealtimeSync["sync"]>;
    onError: (error: Error) => void;
    polling?: boolean;
  }) => void;
  
  unsubscribe: () => Promise<void>;
};
```

## Performance Features Summary

1. **Intelligent Load Balancing**: Automatically selects fastest, least-loaded endpoints
2. **Adaptive Rate Limiting**: Dynamically adjusts request rates based on performance
3. **Automatic Failover**: Seamlessly switches between endpoints on failures
4. **Latency Optimization**: Tracks and optimizes for response times
5. **Concurrency Control**: Manages concurrent requests to prevent overwhelming endpoints
6. **WebSocket Support**: Real-time subscriptions with polling fallback
7. **Error Recovery**: Sophisticated retry logic with exponential backoff
8. **Performance Metrics**: Comprehensive monitoring and logging

This makes the `createRpc` function one of the most sophisticated RPC clients in the blockchain space, capable of maintaining high performance and reliability even under adverse network conditions or when dealing with unreliable RPC endpoints.