- [ ] Add shredWebSocket transport
- [ ] Add new shred types to indexing function subscription
- [ ] Implement rise_subscribe

## SyncRealtime flow

sync -> rpc.riseSubscribe -> realtimeSync.syncShred -> { type: "shred" } -> ShredWithEventData
