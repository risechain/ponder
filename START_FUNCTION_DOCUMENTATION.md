# Ponder Start Function Documentation

## Overview

The `start` function in `@packages/core/src/bin/commands/start.ts` is the main entry point for running a Ponder application. It orchestrates the entire lifecycle of a blockchain indexing application, from initial configuration through database setup, event synchronization, and API server deployment.

## Function Signature

```typescript
export async function start({
  cliOptions,
  onBuild,
}: {
  cliOptions: CliOptions;
  onBuild?: (app: PonderApp) => Promise<PonderApp>;
})
```

### Parameters:
- **cliOptions**: Command-line interface options passed from the CLI
- **onBuild**: Optional callback hook that allows external code to modify the PonderApp after build completion

### Returns:
- A Promise that resolves to a shutdown kill function

## Architecture Flow

```
┌─────────────────┐
│   CLI Options   │
└────────┬────────┘
         │
         v
┌─────────────────┐
│ 1. Initialize   │
│   - Logger      │
│   - Metrics     │
│   - Telemetry   │
│   - Shutdown    │
└────────┬────────┘
         │
         v
┌─────────────────┐
│ 2. Build System │
│   - Namespace   │
│   - Config      │
│   - Schema      │
│   - Indexing    │
│   - API         │
└────────┬────────┘
         │
         v
┌─────────────────┐
│ 3. Database     │
│   - Create      │
│   - Migrate     │
│   - Checkpoint  │
└────────┬────────┘
         │
         v
┌─────────────────┐
│ 4. Execution    │
│   - Run Engine  │
│   - Run Server  │
└─────────────────┘
```

## Detailed Process Flow

### 1. Initialization Phase (Lines 41-83)

#### a) Build Options
```typescript
const options = buildOptions({ cliOptions });
```
Constructs application-wide configuration from CLI arguments, including:
- Root directory and file paths
- Database configuration
- Logging preferences
- Port and hostname settings

#### b) Logger Setup
```typescript
const logger = createLogger({
  level: options.logLevel,
  mode: options.logFormat,
});
```
Creates a structured logger with configured verbosity and output format.

#### c) Node.js Version Check
```typescript
const [major, minor, _patch] = process.versions.node.split(".").map(Number);
if (major < 18 || (major === 18 && minor < 14)) {
  logger.fatal({
    service: "process",
    msg: `Invalid Node.js version. Expected >=18.14, detected ${major}.${minor}.`,
  });
  process.exit(1);
}
```
Ensures the runtime meets minimum version requirements (Node.js >=18.14).

#### d) Service Initialization
```typescript
const metrics = new MetricsService();
const shutdown = createShutdown();
const telemetry = createTelemetry({ options, logger, shutdown });
const common = { options, logger, metrics, telemetry, shutdown };
const exit = createExit({ common });
```
Sets up:
- **Metrics**: Application performance monitoring
- **Shutdown**: Graceful shutdown handling
- **Telemetry**: Anonymous usage tracking
- **Common**: Shared service container
- **Exit**: Coordinated exit handler

### 2. Build System Phase (Lines 83-162)

#### a) Create Build System
```typescript
const build = await createBuild({ common, cliOptions });
```
Initializes the build system with Vite for TypeScript compilation and hot module replacement.

#### b) Namespace Compilation
```typescript
const namespaceResult = build.namespaceCompile();
if (namespaceResult.status === "error") {
  await exit({ reason: "Failed to initialize namespace", code: 1 });
  return;
}
```
Validates database schema configuration and namespace settings.

#### c) Configuration Execution
```typescript
const configResult = await build.executeConfig();
```
Loads and validates `ponder.config.ts`, extracting:
- Network configurations
- Contract definitions
- Database settings
- Transport configurations

#### d) Schema Execution
```typescript
const schemaResult = await build.executeSchema();
```
Loads `ponder.schema.ts` and validates table definitions using Drizzle ORM.

#### e) Pre-Build and Schema Compilation
```typescript
const buildResult1 = mergeResults([
  build.preCompile(configResult.result),
  build.compileSchema(schemaResult.result),
]);
```
- **preCompile**: Processes config into runtime artifacts
- **compileSchema**: Converts schema to SQL statements

#### f) Indexing Functions
```typescript
const indexingResult = await build.executeIndexingFunctions();
const indexingBuildResult = await build.compileIndexing({
  configResult: configResult.result,
  schemaResult: schemaResult.result,
  indexingResult: indexingResult.result,
});
```
Loads and validates all indexing functions from the indexing directory.

#### g) API Build
```typescript
const apiResult = await build.executeApi({
  indexingBuild: indexingBuildResult.result,
  database,
});
const apiBuildResult = await build.compileApi({
  apiResult: apiResult.result,
});
```
Loads API route definitions and validates them against the schema.

### 3. Database Setup Phase (Lines 135-144)

#### a) Database Creation
```typescript
database = await createDatabase({
  common,
  namespace: namespaceResult.result,
  preBuild,
  schemaBuild,
});
```
Creates database connections:
- PostgreSQL with connection pooling OR
- PGLite for local development
- Separate connections for sync and user data

#### b) Migration and Crash Recovery
```typescript
const crashRecoveryCheckpoint = await database.migrate(
  indexingBuildResult.result,
);
```
- Creates/updates database schema
- Handles crash recovery if previous run failed
- Returns checkpoint for resuming indexing

### 4. Execution Phase (Lines 184-211)

#### a) PonderApp Assembly
```typescript
let app: PonderApp = {
  common,
  preBuild,
  namespaceBuild: namespaceResult.result,
  schemaBuild,
  indexingBuild: indexingBuildResult.result,
  apiBuild: apiBuildResult.result,
  crashRecoveryCheckpoint,
};

if (onBuild) {
  app = await onBuild(app);
}
```
Assembles all build artifacts into a PonderApp object and applies optional transformations.

#### b) Run Indexing Engine
```typescript
run({
  ...app,
  database,
  onFatalError: () => {
    exit({ reason: "Received fatal error", code: 1 });
  },
  onReloadableError: () => {
    exit({ reason: "Encountered indexing error", code: 1 });
  },
});
```
Starts the main indexing workflow:
1. Creates sync store for blockchain data caching
2. Initializes sync engine for fetching events
3. Processes historical events in batches
4. Transitions to realtime indexing
5. Handles blockchain reorganizations

#### c) Run API Server
```typescript
runServer({ ...app, database });
```
Starts HTTP server providing:
- User-defined API endpoints
- Internal endpoints (/ready, /status, /metrics, /health)

#### d) Telemetry and Metrics
```typescript
telemetry.record({
  name: "lifecycle:session_start",
  properties: {
    cli_command: "start",
    ...buildPayload({ preBuild, schemaBuild, indexingBuild }),
  },
});

metrics.ponder_settings_info.set({
  ordering: preBuild.ordering,
  database: preBuild.databaseConfig.kind,
  command: cliOptions.command,
}, 1);
```
Records session start and configuration metrics.

## Error Handling

The start function implements comprehensive error handling:

1. **Build Errors**: Each build step checks for errors and exits gracefully
2. **Database Errors**: Connection failures and migration issues are caught
3. **Runtime Errors**: Fatal and reloadable errors have separate handlers
4. **Graceful Shutdown**: The shutdown service coordinates cleanup

Example error handling pattern:
```typescript
if (result.status === "error") {
  await exit({ reason: "Descriptive failure reason", code: 1 });
  return;
}
```

## Key Components

### PonderApp Type
```typescript
export type PonderApp = {
  common: Common;
  preBuild: PreBuild;
  namespaceBuild: NamespaceBuild;
  schemaBuild: SchemaBuild;
  indexingBuild: IndexingBuild;
  apiBuild: ApiBuild;
  crashRecoveryCheckpoint: CrashRecoveryCheckpoint;
};
```

### Common Services
- **Logger**: Structured logging with levels
- **Metrics**: Prometheus-compatible metrics
- **Telemetry**: Anonymous usage tracking
- **Shutdown**: Coordinated cleanup
- **Options**: Merged CLI and config options

## Lifecycle Summary

1. **Parse CLI options** and validate Node.js version
2. **Initialize services** (logger, metrics, telemetry)
3. **Create build system** with hot reloading support
4. **Compile and validate** all user code:
   - Namespace configuration
   - Config file (networks, contracts)
   - Schema file (database tables)
   - Indexing functions (event handlers)
   - API endpoints
5. **Setup database** connections and run migrations
6. **Start indexing engine** to sync blockchain data
7. **Start API server** for data access
8. **Return shutdown function** for graceful termination

## Usage Example

```typescript
import { start } from "@/bin/commands/start.js";

// Basic usage
const shutdown = await start({
  cliOptions: {
    command: "start",
    root: "./my-ponder-app",
    port: 42069,
  },
});

// With build hook
const shutdown = await start({
  cliOptions: { command: "start" },
  onBuild: async (app) => {
    // Modify app configuration
    console.log("Build completed", app);
    return app;
  },
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await shutdown();
});
```

## Conclusion

The start function is the orchestrator of the entire Ponder application lifecycle. It ensures proper initialization, validation, and coordination between all major subsystems: configuration, database, blockchain synchronization, and API serving. Its modular design allows for testing individual components while maintaining a cohesive application flow.