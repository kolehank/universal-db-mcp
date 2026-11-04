# HTTP API Reference

## Overview

Universal Database MCP Server HTTP API provides RESTful endpoints and MCP protocol endpoints for database operations. This API supports 17 database types and includes features like session management, API key authentication, rate limiting, and CORS support.

**Base URL**: `http://localhost:3000` (configurable via `HTTP_PORT` environment variable)

**API Version**: 1.0.0

## Authentication

All endpoints (except `/api/health` and `/api/info`) require API key authentication, including REST API and MCP SSE/Streamable HTTP endpoints.

> **Note**: If `API_KEYS` environment variable is not configured, authentication is skipped (development mode, legacy mode only).

> **3.0+ (registry mode)**: When `DATASOURCE_CONFIG` is set, API keys come from the server-side registry's `apiKeys[]`. Authentication is **mandatory** (even if `API_KEYS` is empty), and `API_KEYS` is ignored.

### Methods

**Option 1: X-API-Key Header**
```http
X-API-Key: your-secret-key
```

**Option 2: Authorization Bearer Token**
```http
Authorization: Bearer your-secret-key
```

### Configuration

Set API keys via environment variable:
```bash
API_KEYS=key1,key2,key3
```

### Error Responses

**401 Unauthorized** - Missing API key
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "API key required. Provide X-API-Key header or Authorization: Bearer <key>"
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

**403 Forbidden** - Invalid API key
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Invalid API key"
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

## Rate Limiting

Default: 100 requests per minute per API key (or IP if no API key)

**Configuration**:
```bash
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW=1m  # 1m, 1h, 1d
```

**Rate Limit Exceeded Response** (429):
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests, please try again later"
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

## Endpoints

### MCP Protocol Endpoints

MCP (Model Context Protocol) endpoints allow AI platforms like Dify to connect to databases directly via the MCP protocol.

#### SSE Endpoints (Legacy)

##### GET /sse

Establish an SSE connection. Database configuration is passed via URL parameters.

**URL Parameters**:
| Parameter | Required | Description |
|-----------|----------|-------------|
| `source` | No | **(3.0+ preferred)** Registered datasource name from the server-side registry. When present, all other parameters below are ignored. |
| `type` | Yes | Database type |
| `host` | Yes* | Database host |
| `port` | No | Database port |
| `user` | Yes* | Username |
| `password` | Yes* | Password |
| `database` | Yes* | Database name |
| `filePath` | Yes* | SQLite file path |
| `allowWrite` | No | Enable write operations (default: false) |
| `permissionMode` | No | Permission mode: `safe` (default), `readwrite`, `full` |
| `permissions` | No | Custom permissions, comma-separated: `read,insert,update,delete,ddl` |

*Required fields depend on database type

> ⚠️ **Note**: Use camelCase for URL parameters (`permissionMode`, `permissions`), not hyphenated names.

> **3.0+**: prefer `?source=<name>`. The raw-parameter (`type`/`host`/...) channel is disabled by default and requires `ALLOW_ADHOC_CONNECTIONS=true`.

**Request Example**:
```bash
curl "http://localhost:3000/sse?source=finance-ro" \
  -H "X-API-Key: your-secret-key"
```

##### POST /sse/message

Send a message to an SSE session.

**Query Parameters**:
- `sessionId` (string, required): SSE session ID

**Request Example**:
```bash
curl -X POST "http://localhost:3000/sse/message?sessionId=your-session-id" \
  -H "X-API-Key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

#### Streamable HTTP Endpoints (MCP 2025 Spec, Recommended)

##### POST /mcp

MCP Streamable HTTP endpoint. Database configuration is passed via headers.

**Header Parameters**:
| Header | Required | Description |
|--------|----------|-------------|
| `X-API-Key` | Yes* | API key (or use Authorization Bearer) |
| `X-DB-Source` | No | **(3.0+ preferred)** Registered datasource name; when present, all other `X-DB-*` connection headers are ignored. |
| `X-DB-Type` | Yes* | Database type |
| `X-DB-Host` | Yes* | Database host |
| `X-DB-Port` | No | Database port |
| `X-DB-User` | Yes* | Username |
| `X-DB-Password` | Yes* | Password |
| `X-DB-Database` | Yes* | Database name |
| `X-DB-FilePath` | Yes* | SQLite file path |
| `X-DB-Allow-Write` | No | Enable write operations (default: false) |
| `X-DB-Permission-Mode` | No | Permission mode: `safe` (default), `readwrite`, `full` |
| `X-DB-Permissions` | No | Custom permissions, comma-separated: `read,insert,update,delete,ddl` |
| `mcp-session-id` | No | Session ID for subsequent requests |

*Required fields depend on database type; authentication required if API_KEYS is configured

> ⚠️ **Note**: Use hyphenated names for HTTP headers (`X-DB-Permission-Mode`, `X-DB-Permissions`).

> **3.0+**: prefer `X-DB-Source`. The legacy raw `X-DB-Type`/`X-DB-Host`/... channel is disabled by default and requires `ALLOW_ADHOC_CONNECTIONS=true`.

**Initialize Request Example**:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "X-API-Key: your-secret-key" \
  -H "Content-Type: application/json" \
  -H "X-DB-Source: finance-ro" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}'
```

**Subsequent Request Example** (with session ID):
```bash
curl -X POST http://localhost:3000/mcp \
  -H "X-API-Key: your-secret-key" \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: your-session-id" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}'
```

##### GET /mcp

Get SSE stream for Streamable HTTP.

**Headers**:
- `mcp-session-id` (string, required): Session ID
- `X-API-Key` (string, required*): API key

##### DELETE /mcp

Close an MCP session.

**Query Parameters or Headers**:
- `sessionId` or `mcp-session-id`: Session ID

**Request Example**:
```bash
curl -X DELETE "http://localhost:3000/mcp?sessionId=your-session-id" \
  -H "X-API-Key: your-secret-key"
```

#### MCP Tools

The following tools are available after connecting via MCP protocol:

| Tool Name | Description |
|-----------|-------------|
| `execute_query` | Execute SQL queries or database commands |
| `get_schema` | Get database schema information |
| `get_table_info` | Get detailed information about a specific table |
| `clear_cache` | Clear schema cache |
| `get_enum_values` | Get all unique values for a column (for enum-type columns like status, type) |
| `get_sample_data` | Get sample data from a table (with automatic data masking for privacy) |
| `connect_database` | Dynamically connect to a database (supports all 17 database types, auto-disconnects existing connection) |
| `disconnect_database` | Disconnect from the current database |
| `get_connection_status` | Get current database connection status (type, host, permissions, cache info) |

### REST API Endpoints

### Health & Info

#### GET /api/health

Health check endpoint (no authentication required).

**Request**:
```bash
curl http://localhost:3000/api/health
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "uptime": 3600.5,
    "timestamp": "2026-01-27T12:00:00.000Z"
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

#### GET /api/info

Service information endpoint (no authentication required).

**Request**:
```bash
curl http://localhost:3000/api/info
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "name": "universal-db-mcp",
    "version": "1.0.0",
    "mode": "http",
    "supportedDatabases": [
      "mysql", "postgres", "redis", "oracle", "dm",
      "sqlserver", "mongodb", "sqlite", "kingbase",
      "gaussdb", "oceanbase", "tidb", "clickhouse",
      "polardb", "vastbase", "highgo", "goldendb"
    ]
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

### Connection Management

#### POST /api/connect

Connect to a database and create a session.

**Request Body**:
```json
{
  "type": "mysql",
  "host": "localhost",
  "port": 3306,
  "user": "root",
  "password": "your_password",
  "database": "mydb",
  "allowWrite": false,
  "permissionMode": "safe",
  "permissions": ["read", "insert"]
}
```

**Parameters**:
- `source` (string, optional): **(3.0+)** Registered datasource name from the server-side registry (`DATASOURCE_CONFIG`). When provided, all other connection fields (`type`/`host`/`port`/`user`/`password`/`database`/...) are **ignored** and connection parameters come from the registry. Preferred in 3.0+.
- `type` (string, required for legacy/adhoc): Database type (mysql, postgres, redis, oracle, dm, sqlserver, mongodb, sqlite, kingbase, gaussdb, oceanbase, tidb, clickhouse, polardb, vastbase, highgo, goldendb)
- `host` (string, required for non-SQLite): Database host
- `port` (number, required for non-SQLite): Database port
- `user` (string, optional): Username
- `password` (string, optional): Password
- `database` (string, optional): Database name
- `filePath` (string, required for SQLite): SQLite database file path
- `authSource` (string, optional for MongoDB): Authentication database (default: admin)
- `allowWrite` (boolean, optional): Enable write operations (default: false) - deprecated, use `permissionMode`
- `permissionMode` (string, optional): Permission mode: `safe` (default), `readwrite`, `full`
- `permissions` (array, optional): Custom permissions array: `["read", "insert", "update", "delete", "ddl"]`

> ⚠️ **Note**: Use camelCase for JSON body (`permissionMode`, `permissions`), not hyphenated names like `permission-mode`.

**Request Example**:
```bash
curl -X POST http://localhost:3000/api/connect \
  -H "X-API-Key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "mysql",
    "host": "localhost",
    "port": 3306,
    "user": "root",
    "password": "password",
    "database": "testdb"
  }'
```

**Registry Source Example** (3.0+):
```bash
curl -X POST http://localhost:3000/api/connect \
  -H "X-API-Key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "finance-ro"
  }'
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "sessionId": "V1StGXR8_Z5jdHi6B-myT",
    "databaseType": "mysql",
    "connected": true
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

**Error Response** (502):
```json
{
  "success": false,
  "error": {
    "code": "CONNECT_FAILED",
    "message": "Access denied for user 'root'@'localhost'"
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

**ACL Error Responses** (3.0+, registry mode):

| HTTP | Code | When |
|------|------|------|
| 400 | `INVALID_REQUEST` | No connection parameters provided (no `source`, no connection fields) |
| 403 | `ADHOC_DISABLED` | Raw `type`/`host`/... parameters sent while adhoc is disabled |
| 403 | `ADHOC_TARGET_DENIED` | Adhoc target is not in `adhocTargetAllowlist` |
| 404 | `SOURCE_NOT_FOUND` | Source does not exist **or** is not in the key's `allowedSources` (deliberately indistinguishable) |
| 403 | `PERMISSION_DENIED` | Operation exceeds the effective permission (see `/api/query`) |
| 502 | `CONNECT_FAILED` | Server failed to connect to the database |

#### POST /api/disconnect

Disconnect from a database and close the session.

**Request Body**:
```json
{
  "sessionId": "V1StGXR8_Z5jdHi6B-myT"
}
```

**Request Example**:
```bash
curl -X POST http://localhost:3000/api/disconnect \
  -H "X-API-Key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "V1StGXR8_Z5jdHi6B-myT"}'
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "disconnected": true
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

### Query Execution

#### POST /api/query

Execute a read query (SELECT, SHOW, DESCRIBE, etc.).

**Request Body**:
```json
{
  "sessionId": "V1StGXR8_Z5jdHi6B-myT",
  "query": "SELECT * FROM users WHERE id = ?",
  "params": [1]
}
```

**Parameters**:
- `sessionId` (string, required): Session ID from `/api/connect`
- `query` (string, required): SQL query or database command
- `params` (array, optional): Query parameters for parameterized queries

**Request Example**:
```bash
curl -X POST http://localhost:3000/api/query \
  -H "X-API-Key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "V1StGXR8_Z5jdHi6B-myT",
    "query": "SELECT * FROM users LIMIT 10"
  }'
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "rows": [
      {"id": 1, "name": "Alice", "email": "alice@example.com"},
      {"id": 2, "name": "Bob", "email": "bob@example.com"}
    ],
    "executionTime": 15,
    "metadata": {
      "fieldCount": 3
    }
  },
  "metadata": {
    "executionTime": 15,
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

**Error Response - Write Permission Denied** (403):
```json
{
  "success": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "❌ 操作被拒绝：当前权限不允许该操作"
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

#### POST /api/execute

Execute a write operation (INSERT, UPDATE, DELETE, etc.). Requires `allowWrite: true` in connection config.

> **3.0+ note**: In registry mode, client-provided `allowWrite`/`permissionMode` are ignored; write access is determined by the source's `maxPermission`. A blocked write returns **403 `PERMISSION_DENIED`** (audited as `denied`).

**Request Body**:
```json
{
  "sessionId": "V1StGXR8_Z5jdHi6B-myT",
  "query": "INSERT INTO users (name, email) VALUES (?, ?)",
  "params": ["Charlie", "charlie@example.com"]
}
```

**Request Example**:
```bash
curl -X POST http://localhost:3000/api/execute \
  -H "X-API-Key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "V1StGXR8_Z5jdHi6B-myT",
    "query": "UPDATE users SET name = ? WHERE id = ?",
    "params": ["Alice Smith", 1]
  }'
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "rows": [],
    "affectedRows": 1,
    "executionTime": 8
  },
  "metadata": {
    "executionTime": 8,
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

### Schema Information

#### GET /api/tables

List all tables in the database.

**Query Parameters**:
- `sessionId` (string, required): Session ID from `/api/connect`

**Request Example**:
```bash
curl "http://localhost:3000/api/tables?sessionId=V1StGXR8_Z5jdHi6B-myT" \
  -H "X-API-Key: your-secret-key"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "tables": ["users", "orders", "products", "categories"]
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

#### GET /api/schema

Get complete database schema.

**Query Parameters**:
- `sessionId` (string, required): Session ID from `/api/connect`

**Request Example**:
```bash
curl "http://localhost:3000/api/schema?sessionId=V1StGXR8_Z5jdHi6B-myT" \
  -H "X-API-Key: your-secret-key"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "type": "mysql",
    "name": "testdb",
    "version": "8.0.32",
    "tables": [
      {
        "name": "orders",
        "columns": [
          {
            "name": "id",
            "type": "int",
            "nullable": false,
            "default": null,
            "comment": "Order ID"
          },
          {
            "name": "user_id",
            "type": "int",
            "nullable": false,
            "default": null,
            "comment": "User ID"
          }
        ],
        "primaryKey": ["id"],
        "indexes": [
          {
            "name": "PRIMARY",
            "columns": ["id"],
            "unique": true
          }
        ],
        "foreignKeys": [
          {
            "name": "fk_orders_user",
            "columns": ["user_id"],
            "referencedTable": "users",
            "referencedColumns": ["id"],
            "onDelete": "CASCADE",
            "onUpdate": "NO ACTION"
          }
        ],
        "estimatedRows": 5000
      },
      {
        "name": "users",
        "columns": [
          {
            "name": "id",
            "type": "int",
            "nullable": false,
            "default": null,
            "comment": "User ID"
          },
          {
            "name": "name",
            "type": "varchar(255)",
            "nullable": false,
            "default": null,
            "comment": "User name"
          }
        ],
        "primaryKey": ["id"],
        "indexes": [
          {
            "name": "PRIMARY",
            "columns": ["id"],
            "unique": true
          }
        ],
        "estimatedRows": 1000
      }
    ],
    "relationships": [
      {
        "fromTable": "orders",
        "fromColumns": ["user_id"],
        "toTable": "users",
        "toColumns": ["id"],
        "type": "many-to-one",
        "constraintName": "fk_orders_user"
      }
    ]
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

#### GET /api/schema/:table

Get information about a specific table.

**Path Parameters**:
- `table` (string, required): Table name. Supports `schema.table_name` format (e.g., `analytics.users`).

**Query Parameters**:
- `sessionId` (string, required): Session ID from `/api/connect`

**Request Example**:
```bash
curl "http://localhost:3000/api/schema/users?sessionId=V1StGXR8_Z5jdHi6B-myT" \
  -H "X-API-Key: your-secret-key"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "name": "orders",
    "columns": [
      {
        "name": "id",
        "type": "int",
        "nullable": false,
        "default": null,
        "comment": "Order ID"
      },
      {
        "name": "user_id",
        "type": "int",
        "nullable": false,
        "default": null,
        "comment": "User ID"
      },
      {
        "name": "amount",
        "type": "decimal(10,2)",
        "nullable": false,
        "default": null,
        "comment": "Order amount"
      }
    ],
    "primaryKey": ["id"],
    "indexes": [
      {
        "name": "PRIMARY",
        "columns": ["id"],
        "unique": true
      },
      {
        "name": "idx_user_id",
        "columns": ["user_id"],
        "unique": false
      }
    ],
    "foreignKeys": [
      {
        "name": "fk_orders_user",
        "columns": ["user_id"],
        "referencedTable": "users",
        "referencedColumns": ["id"],
        "onDelete": "CASCADE",
        "onUpdate": "NO ACTION"
      }
    ],
    "estimatedRows": 5000
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

#### GET /api/enum-values

Get all unique values for a column. Useful for understanding enum-type columns like status, type, category.

**Query Parameters**:
- `sessionId` (string, required): Session ID from `/api/connect`
- `tableName` (string, required): Table name. Supports `schema.table_name` format (e.g., `analytics.users`).
- `columnName` (string, required): Column name
- `limit` (string, optional): Maximum number of values to return (default: 50, max: 100)
- `includeCount` (string, optional): Include count for each value (true/false, default: false)

**Request Example**:
```bash
curl "http://localhost:3000/api/enum-values?sessionId=V1StGXR8_Z5jdHi6B-myT&tableName=orders&columnName=status&includeCount=true" \
  -H "X-API-Key: your-secret-key"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "tableName": "orders",
    "columnName": "status",
    "values": ["pending", "paid", "shipped", "delivered", "cancelled"],
    "totalCount": 5,
    "isEnum": true,
    "valueCounts": {
      "pending": 1200,
      "paid": 3500,
      "shipped": 2100,
      "delivered": 8500,
      "cancelled": 450
    },
    "columnType": "varchar(50)"
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

**Note**: This endpoint is not available for NoSQL databases (Redis, MongoDB).

#### GET /api/sample-data

Get sample data from a table with automatic data masking for privacy protection.

**Query Parameters**:
- `sessionId` (string, required): Session ID from `/api/connect`
- `tableName` (string, required): Table name. Supports `schema.table_name` format (e.g., `analytics.users`).
- `columns` (string, optional): Comma-separated list of columns to include
- `limit` (string, optional): Number of rows to return (default: 3, max: 10)

**Request Example**:
```bash
curl "http://localhost:3000/api/sample-data?sessionId=V1StGXR8_Z5jdHi6B-myT&tableName=users&columns=id,name,email,phone&limit=3" \
  -H "X-API-Key: your-secret-key"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "tableName": "users",
    "columns": ["id", "name", "email", "phone"],
    "rows": [
      {"id": 1, "name": "Alice", "email": "a***@example.com", "phone": "138****5678"},
      {"id": 2, "name": "Bob", "email": "b***@company.org", "phone": "139****1234"},
      {"id": 3, "name": "Charlie", "email": "c***@test.com", "phone": "136****9876"}
    ],
    "rowCount": 3,
    "masked": true,
    "maskedColumns": ["email", "phone"]
  },
  "metadata": {
    "timestamp": "2026-01-27T12:00:00.000Z",
    "requestId": "abc123"
  }
}
```

**Data Masking Rules**:
| Data Type | Masking Pattern | Example |
|-----------|-----------------|---------|
| Phone | Middle 4 digits hidden | `138****5678` |
| Email | Username partially hidden | `a***@example.com` |
| ID Card | Middle 11 digits hidden | `110***********1234` |
| Bank Card | Only last 4 digits shown | `************1234` |
| Password/Secret | Fully hidden | `******` |

**Note**: This endpoint is not available for NoSQL databases (Redis, MongoDB).

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing API key |
| `FORBIDDEN` | 403 | Invalid API key |
| `INVALID_REQUEST` | 400 | Missing/invalid connection parameters (no `source` and no connection fields) |
| `ADHOC_DISABLED` | 403 | Raw connection parameters sent while adhoc is disabled |
| `ADHOC_TARGET_DENIED` | 403 | Adhoc target is not in `adhocTargetAllowlist` |
| `SOURCE_NOT_FOUND` | 404 | Source does not exist or is not allowed for this API key |
| `PERMISSION_DENIED` | 403 | Operation exceeds the effective permission |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `CONNECT_FAILED` | 502 | Failed to connect to the database |
| `DISCONNECTION_FAILED` | 500 | Failed to disconnect from database |
| `QUERY_FAILED` | 500 | Failed to execute query |
| `EXECUTE_FAILED` | 500 | Failed to execute operation |
| `LIST_TABLES_FAILED` | 500 | Failed to list tables |
| `GET_SCHEMA_FAILED` | 500 | Failed to get schema |
| `GET_TABLE_INFO_FAILED` | 500 | Failed to get table information |
| `GET_ENUM_VALUES_FAILED` | 500 | Failed to get enum values |
| `GET_SAMPLE_DATA_FAILED` | 500 | Failed to get sample data |
| `INTERNAL_ERROR` | 500 | Internal server error |

## Session Management

### Session Lifecycle

1. **Create**: Call `/api/connect` to create a session
2. **Use**: Use the `sessionId` in subsequent API calls
3. **Close**: Call `/api/disconnect` to close the session

### Session Timeout

Sessions automatically expire after inactivity (default: 1 hour).

**Configuration**:
```bash
SESSION_TIMEOUT=3600000  # 1 hour in milliseconds
SESSION_CLEANUP_INTERVAL=300000  # 5 minutes
```

### Session Cleanup

Expired sessions are automatically cleaned up every 5 minutes (configurable).

## Database-Specific Examples

> These examples use the legacy/adhoc path (raw connection fields). In 3.0+, if a registry is configured (`DATASOURCE_CONFIG`), use `"source"` instead — see [POST /api/connect](#post-apiconnect). The raw `type`/`host`/... channel requires `ALLOW_ADHOC_CONNECTIONS=true`.

### MySQL
```bash
curl -X POST http://localhost:3000/api/connect \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "mysql",
    "host": "localhost",
    "port": 3306,
    "user": "root",
    "password": "password",
    "database": "mydb"
  }'
```

### PostgreSQL
```bash
curl -X POST http://localhost:3000/api/connect \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "user": "postgres",
    "password": "password",
    "database": "mydb"
  }'
```

### Redis
```bash
curl -X POST http://localhost:3000/api/connect \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "redis",
    "host": "localhost",
    "port": 6379,
    "password": "password"
  }'
```

### MongoDB
```bash
curl -X POST http://localhost:3000/api/connect \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "mongodb",
    "host": "localhost",
    "port": 27017,
    "user": "admin",
    "password": "password",
    "database": "mydb",
    "authSource": "admin"
  }'
```

### SQLite
```bash
curl -X POST http://localhost:3000/api/connect \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "sqlite",
    "filePath": "/path/to/database.db",
    "allowWrite": false
  }'
```

## Best Practices

### Security

1. **Use Strong API Keys**: Generate cryptographically secure random keys
2. **Enable HTTPS**: Use reverse proxy (nginx, Caddy) for HTTPS in production
3. **Restrict CORS**: Set specific origins instead of `*`
4. **Read-Only by Default**: Only enable `allowWrite` when necessary
5. **Close Sessions**: Always call `/api/disconnect` when done

### Performance

1. **Reuse Sessions**: Keep sessions alive for multiple queries
2. **Use Parameterized Queries**: Prevent SQL injection and improve performance
3. **Limit Result Sets**: Use `LIMIT` clauses for large tables
4. **Monitor Rate Limits**: Implement exponential backoff for rate limit errors

### Error Handling

1. **Check `success` Field**: Always check the `success` field in responses
2. **Handle Rate Limits**: Implement retry logic with backoff
3. **Session Expiry**: Reconnect if session expires
4. **Log Request IDs**: Use `requestId` from metadata for debugging

## Complete Workflow Example

```bash
# 1. Connect to database
RESPONSE=$(curl -s -X POST http://localhost:3000/api/connect \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "mysql",
    "host": "localhost",
    "port": 3306,
    "user": "root",
    "password": "password",
    "database": "testdb"
  }')

# 2. Extract session ID
SESSION_ID=$(echo $RESPONSE | jq -r '.data.sessionId')

# 3. List tables
curl "http://localhost:3000/api/tables?sessionId=$SESSION_ID" \
  -H "X-API-Key: your-key"

# 4. Get table schema
curl "http://localhost:3000/api/schema/users?sessionId=$SESSION_ID" \
  -H "X-API-Key: your-key"

# 5. Execute query
curl -X POST http://localhost:3000/api/query \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d "{
    \"sessionId\": \"$SESSION_ID\",
    \"query\": \"SELECT * FROM users LIMIT 10\"
  }"

# 6. Disconnect
curl -X POST http://localhost:3000/api/disconnect \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\": \"$SESSION_ID\"}"
```

## Support

For issues and questions:
- GitHub Issues: https://github.com/Anarkh-Lee/universal-db-mcp/issues
- Documentation: https://github.com/Anarkh-Lee/universal-db-mcp#readme
