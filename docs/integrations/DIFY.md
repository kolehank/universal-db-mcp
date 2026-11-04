# Dify Integration Guide

This guide shows how to integrate Universal Database MCP Server with Dify AI application development platform.

## Overview

Dify is an LLM application development platform. By integrating Universal Database MCP Server, you can enable your Dify applications to query and analyze database data.

**Two Integration Methods:**
1. **MCP Protocol (Recommended)** - Use Dify's native MCP tool support via SSE/Streamable HTTP
2. **Custom API Tool** - Use HTTP REST API as custom tools

## Prerequisites

- Universal Database MCP Server deployed with HTTP mode
- Dify account (self-hosted or cloud)
- Database instance (MySQL, PostgreSQL, etc.)

---

## Method 1: MCP Protocol Integration (Recommended)

This method uses Dify's native MCP tool support, providing a more seamless integration experience.

### Step 1: Deploy HTTP Server

Deploy Universal Database MCP Server in HTTP mode:

```bash
# Using npm
export MODE=http
export HTTP_PORT=3000
export API_KEYS=your-secret-key  # Optional: Enable API key authentication
npx universal-db-mcp

# Or using Docker
docker run -d \
  --name universal-db-mcp \
  -p 3000:3000 \
  -e MODE=http \
  -e HTTP_PORT=3000 \
  -e API_KEYS=your-secret-key \
  universal-db-mcp:latest
```

> **Note**: If `API_KEYS` is configured, all MCP endpoints require authentication via `X-API-Key` header or `Authorization: Bearer <key>`.
>
> **3.0+**: registry mode is recommended — set `DATASOURCE_CONFIG` to a registry file (see [Data Source ACL guide](../guides/datasource-acl.md)). In registry mode `API_KEYS` is ignored (keys are defined in the registry's `apiKeys[]`), and MCP endpoints connect via `X-DB-Source` (Streamable HTTP) or `?source=` (SSE).

### Step 2: Configure MCP Tool in Dify

1. Login to [Dify](https://dify.ai/)
2. Go to **Tools** > **MCP Tools**
3. Click **Add MCP Server**
4. Configure the MCP server using one of the following methods:

#### Option A: SSE Endpoint (Legacy)

**Server Name**: `Universal DB MCP`

**Server URL**:
```
http://your-server:3000/sse?source=finance-ro
```

**Headers** (if API_KEYS is configured):
```
X-API-Key: your-secret-key
```

Database configuration comes from the server-side registry (3.0 recommended). Legacy: with `ALLOW_ADHOC_CONNECTIONS=true` the raw `?type=mysql&host=...` URL parameters still work (2.x behavior).

#### Option B: Streamable HTTP Endpoint (Recommended)

**Server Name**: `Universal DB MCP`

**Server URL**:
```
http://your-server:3000/mcp
```

**Headers**:
```
X-API-Key: your-secret-key
X-DB-Source: finance-ro
```

The source must be a registered datasource name (3.0 recommended; connection parameters come from the server-side registry). Legacy: with `ALLOW_ADHOC_CONNECTIONS=true` the raw `X-DB-Type`/`X-DB-Host`/... headers still work (2.x behavior).

### Available Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sse` | GET | Establish SSE connection (legacy) |
| `/sse/message` | POST | Send message to SSE session |
| `/mcp` | POST | Streamable HTTP endpoint (recommended) |
| `/mcp` | GET | SSE stream for Streamable HTTP |
| `/mcp` | DELETE | Close session |

### Step 3: Use MCP Tools in Application

Once configured, the following MCP tools will be available in your Dify application:

| Tool | Description |
|------|-------------|
| `execute_query` | Execute SQL queries |
| `get_schema` | Get database schema information |
| `get_table_info` | Get detailed table information |
| `clear_cache` | Clear schema cache |
| `get_enum_values` | Get all unique values for a specified column |
| `get_sample_data` | Get sample data from a table (with automatic data masking) |
| `connect_database` | Dynamically connect to a database (supports all 17 types) |
| `disconnect_database` | Disconnect from the current database |
| `get_connection_status` | Get current database connection status |

> **3.0+ registry mode**: the toolset is `connect_datasource` / `list_datasources` instead of `connect_database` — tools switch between registered sources by name; `connect_database` is not exposed.

### MCP SSE URL Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `source` | No (3.0+ preferred) | Registered datasource name from the server-side registry; when present, other parameters below are ignored |
| `type` | Yes | Database type: mysql, postgres, redis, oracle, dm, sqlserver, mongodb, sqlite, kingbase, gaussdb, oceanbase, tidb, clickhouse, polardb, vastbase, highgo, goldendb (legacy; requires `ALLOW_ADHOC_CONNECTIONS=true`) |
| `host` | Yes* | Database host |
| `port` | No | Database port (uses default if not specified) |
| `user` | Yes* | Database username |
| `password` | Yes* | Database password |
| `database` | Yes* | Database name |
| `filePath` | Yes* | SQLite file path (for sqlite type) |
| `allowWrite` | No | Enable write operations (default: false) |
| `permissionMode` | No | Permission mode: `safe` (default), `readwrite`, `full` |
| `permissions` | No | Custom permissions, comma-separated: `read,insert,update,delete,ddl` |

*Required fields depend on database type

> ⚠️ **Note**: Use camelCase for URL parameters (`permissionMode`), not hyphenated names.

### Example SSE URLs

> In 3.0+, prefer `http://localhost:3000/sse?source=<registered-source-name>`. The URLs below are the legacy raw-parameter form (requires `ALLOW_ADHOC_CONNECTIONS=true`).

**MySQL:**
```
http://localhost:3000/sse?type=mysql&host=localhost&port=3306&user=root&password=secret&database=myapp
```

**PostgreSQL:**
```
http://localhost:3000/sse?type=postgres&host=localhost&port=5432&user=postgres&password=secret&database=myapp
```

**SQLite:**
```
http://localhost:3000/sse?type=sqlite&filePath=/path/to/database.db
```

**Redis:**
```
http://localhost:3000/sse?type=redis&host=localhost&port=6379&password=secret
```

### Streamable HTTP Headers

| Header | Required | Description |
|--------|----------|-------------|
| `X-DB-Source` | No (3.0+ preferred) | Registered datasource name from the server-side registry; when present, other `X-DB-*` connection headers are ignored |
| `X-DB-Type` | Yes | Database type: mysql, postgres, redis, oracle, dm, sqlserver, mongodb, sqlite, kingbase, gaussdb, oceanbase, tidb, clickhouse, polardb, vastbase, highgo, goldendb (legacy; requires `ALLOW_ADHOC_CONNECTIONS=true`) |
| `X-DB-Host` | Yes* | Database host |
| `X-DB-Port` | No | Database port (uses default if not specified) |
| `X-DB-User` | Yes* | Database username |
| `X-DB-Password` | Yes* | Database password |
| `X-DB-Database` | Yes* | Database name |
| `X-DB-FilePath` | Yes* | SQLite file path (for sqlite type) |
| `X-DB-Allow-Write` | No | Enable write operations (default: false) |
| `X-DB-Permission-Mode` | No | Permission mode: `safe` (default), `readwrite`, `full` |
| `X-DB-Permissions` | No | Custom permissions, comma-separated: `read,insert,update,delete,ddl` |
| `X-DB-Oracle-Client-Path` | No | Oracle Instant Client path (for Oracle 11g) |
| `mcp-session-id` | No | Session ID for subsequent requests |

*Required fields depend on database type

> ⚠️ **Note**: Use hyphenated names for HTTP headers (`X-DB-Permission-Mode`).

> **3.0+**: prefer `X-DB-Source`. The legacy raw `X-DB-Type`/`X-DB-Host`/... channel is disabled by default and only works when `ALLOW_ADHOC_CONNECTIONS=true`.

### Example Streamable HTTP Requests

**Initialize Connection (MySQL):**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "X-DB-Source: finance-ro" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}'
```

**Subsequent Requests (with session ID):**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: your-session-id" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}'
```

---

## Method 2: Custom API Tool Integration

This method uses Dify's custom API tool feature with the REST API endpoints.

### Step 1: Deploy HTTP API Server

Deploy Universal Database MCP Server:

```bash
docker run -d \
  --name universal-db-mcp \
  -p 3000:3000 \
  -e MODE=http \
  -e HTTP_PORT=3000 \
  -e API_KEYS=dify-secret-key \
  -e CORS_ORIGINS=* \
  universal-db-mcp:latest
```

### Step 2: Create Dify Application

1. Login to [Dify](https://dify.ai/)
2. Click "Create Application"
3. Select application type:
   - **Chatbot**: For conversational database queries
   - **Agent**: For autonomous database operations
   - **Workflow**: For structured database workflows
4. Name your application (e.g., "Database Assistant")

### Step 3: Add API Tool

1. In application editor, go to "Tools" section
2. Click "Add Tool"
3. Select "Custom API"
4. Configure API tool

### Step 4: Configure API Tool

#### Basic Information

**Tool Name**: `Database Query Tool`
**Description**: `Query and analyze database data`
**Icon**: Choose database icon

#### Authentication

**Type**: `API Key`
**Header Name**: `X-API-Key`
**API Key**: `dify-secret-key`

#### API Endpoints

Add the following endpoints:

##### Endpoint 1: Connect Database

**Name**: `connect_database`
**Method**: `POST`
**URL**: `https://your-api-url/api/connect`
**Description**: Connect to a database

**Request Schema**:
```json
{
  "type": "object",
  "properties": {
    "source": {
      "type": "string",
      "description": "Registered datasource name (3.0+ preferred; when present, other fields are ignored)"
    },
    "type": {
      "type": "string",
      "description": "Database type (mysql, postgres, redis, etc.) — legacy, requires ALLOW_ADHOC_CONNECTIONS=true",
      "enum": ["mysql", "postgres", "redis", "mongodb", "sqlite"]
    },
    "host": {
      "type": "string",
      "description": "Database host"
    },
    "port": {
      "type": "integer",
      "description": "Database port"
    },
    "user": {
      "type": "string",
      "description": "Username"
    },
    "password": {
      "type": "string",
      "description": "Password"
    },
    "database": {
      "type": "string",
      "description": "Database name"
    }
  },
  "required": ["type", "host", "port"]
}
```

**Response Schema**:
```json
{
  "type": "object",
  "properties": {
    "success": {"type": "boolean"},
    "data": {
      "type": "object",
      "properties": {
        "sessionId": {"type": "string"},
        "databaseType": {"type": "string"},
        "connected": {"type": "boolean"}
      }
    }
  }
}
```

##### Endpoint 2: Execute Query

**Name**: `execute_query`
**Method**: `POST`
**URL**: `https://your-api-url/api/query`
**Description**: Execute SQL query

**Request Schema**:
```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Session ID from connect_database"
    },
    "query": {
      "type": "string",
      "description": "SQL query to execute"
    },
    "params": {
      "type": "array",
      "description": "Query parameters (optional)"
    }
  },
  "required": ["sessionId", "query"]
}
```

**Response Schema**:
```json
{
  "type": "object",
  "properties": {
    "success": {"type": "boolean"},
    "data": {
      "type": "object",
      "properties": {
        "rows": {"type": "array"},
        "executionTime": {"type": "number"}
      }
    }
  }
}
```

##### Endpoint 3: List Tables

**Name**: `list_tables`
**Method**: `GET`
**URL**: `https://your-api-url/api/tables`
**Description**: List all tables

**Query Parameters**:
```json
{
  "sessionId": {
    "type": "string",
    "required": true,
    "description": "Session ID"
  }
}
```

##### Endpoint 4: Get Table Schema

**Name**: `get_table_schema`
**Method**: `GET`
**URL**: `https://your-api-url/api/schema/{table}`
**Description**: Get table structure

**Path Parameters**:
```json
{
  "table": {
    "type": "string",
    "required": true,
    "description": "Table name"
  }
}
```

**Query Parameters**:
```json
{
  "sessionId": {
    "type": "string",
    "required": true,
    "description": "Session ID"
  }
}
```

### Step 5: Configure Application Prompt

#### For Chatbot Application

**System Prompt**:
```
You are a database assistant that helps users query and analyze database data.

Available tools:
- connect_database: Connect to a database
- execute_query: Execute SQL queries
- list_tables: List all tables in database
- get_table_schema: Get table structure

Workflow:
1. When user wants to query data, first check if connected to database
2. If not connected, ask for database credentials and use connect_database
3. Use list_tables to see available tables
4. Use get_table_schema to understand table structure
5. Generate appropriate SQL query based on user's question
6. Use execute_query to run the query
7. Format and present results in a clear, readable way

Guidelines:
- Always validate SQL queries before execution
- Use parameterized queries when possible
- Limit result sets to prevent overwhelming output
- Explain query logic to users
- Handle errors gracefully
```

**Opening Statement**:
```
Hello! I'm your database assistant. I can help you query and analyze your database data using natural language.

To get started, please provide your database connection details:
- Database type (MySQL, PostgreSQL, etc.)
- Host and port
- Username and password
- Database name

Or you can ask me questions like:
- "Show me all users"
- "How many orders were placed last month?"
- "What's the average order value?"
```

#### For Agent Application

**Agent Instructions**:
```
You are an autonomous database agent that can:
1. Connect to databases
2. Explore database schema
3. Execute queries
4. Analyze data
5. Generate reports

Tools available:
- connect_database
- execute_query
- list_tables
- get_table_schema

When given a task:
1. Break it down into steps
2. Use tools to gather information
3. Execute queries as needed
4. Synthesize results
5. Present findings clearly
```

#### For Workflow Application

Create a workflow with these nodes:

1. **Start Node**: Receives user input
2. **LLM Node**: Analyzes user request
3. **Tool Node**: Connects to database
4. **Tool Node**: Lists tables
5. **Tool Node**: Gets table schema
6. **LLM Node**: Generates SQL query
7. **Tool Node**: Executes query
8. **LLM Node**: Formats results
9. **End Node**: Returns response

### Step 6: Test Application

Test with sample queries:

**Example 1: Simple Query**
```
User: Show me all users
Assistant: Let me query the database for you.
[Calls list_tables]
[Calls get_table_schema for "users"]
[Generates SQL: SELECT * FROM users LIMIT 10]
[Calls execute_query]
Assistant: Here are the users:
1. Alice (alice@example.com)
2. Bob (bob@example.com)
...
```

**Example 2: Aggregation**
```
User: How many orders were placed last month?
Assistant: I'll check the orders for you.
[Analyzes schema]
[Generates SQL: SELECT COUNT(*) FROM orders WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)]
[Executes query]
Assistant: There were 1,234 orders placed last month.
```

**Example 3: Complex Analysis**
```
User: What's the revenue by product category?
Assistant: Let me analyze the revenue data.
[Joins orders and products tables]
[Groups by category]
[Calculates sum]
Assistant: Revenue by category:
- Electronics: $45,230
- Clothing: $32,100
- Books: $18,450
```

## Advanced Features

### Variable Management

Store session ID in Dify variables:

```python
# In workflow
session_id = connect_database(params)
set_variable("db_session_id", session_id)

# Later use
session_id = get_variable("db_session_id")
execute_query(session_id, query)
```

### Context Memory

Use Dify's memory feature to remember database connections:

```python
# Store in conversation memory
memory.set("database_type", "mysql")
memory.set("session_id", session_id)

# Retrieve later
session_id = memory.get("session_id")
```

### Query Templates

Create reusable query templates:

```sql
-- Template: Get user by email
SELECT * FROM users WHERE email = ?

-- Template: Get orders by date range
SELECT * FROM orders
WHERE created_at BETWEEN ? AND ?
ORDER BY created_at DESC

-- Template: Revenue by period
SELECT
  DATE_FORMAT(created_at, '%Y-%m') as month,
  SUM(total_amount) as revenue
FROM orders
WHERE created_at >= ?
GROUP BY month
ORDER BY month DESC
```

### Data Visualization

Integrate with Dify's visualization features:

```python
# Query data
results = execute_query(session_id, query)

# Format for chart
chart_data = {
  "type": "bar",
  "data": {
    "labels": [row["month"] for row in results],
    "datasets": [{
      "label": "Revenue",
      "data": [row["revenue"] for row in results]
    }]
  }
}

return chart_data
```

## Use Cases

### Use Case 1: Customer Service Bot

**Scenario**: Customer service agents query customer data

**Features**:
- Look up customer information
- Check order status
- View purchase history
- Update customer notes

**Example Queries**:
```
- "Find customer with email alice@example.com"
- "Show orders for customer ID 123"
- "What's the status of order #456?"
```

### Use Case 2: Business Intelligence Agent

**Scenario**: Executives get business insights

**Features**:
- Revenue analysis
- Customer metrics
- Product performance
- Trend analysis

**Example Queries**:
```
- "What's our revenue this quarter?"
- "Show top 10 customers by revenue"
- "Which products are selling best?"
- "What's the customer retention rate?"
```

### Use Case 3: Data Export Workflow

**Scenario**: Automated data export and reporting

**Workflow**:
1. Schedule trigger (daily)
2. Connect to database
3. Execute export query
4. Format as CSV/Excel
5. Send via email/Slack
6. Disconnect

### Use Case 4: Database Monitoring

**Scenario**: Monitor database health and performance

**Features**:
- Table size monitoring
- Query performance tracking
- Alert on anomalies
- Automated reports

## Best Practices

### 1. Security

- Use read-only database users
- Store credentials securely in Dify secrets
- Validate all SQL queries
- Implement query whitelisting

### 2. Performance

- Add LIMIT to queries
- Use indexes on frequently queried columns
- Implement caching for schema information
- Monitor query execution time

### 3. Error Handling

- Catch and handle database errors
- Provide user-friendly error messages
- Implement retry logic
- Log errors for debugging

### 4. User Experience

- Provide clear instructions
- Show query progress
- Format results nicely
- Offer query suggestions

## Integration Patterns

### Pattern 1: RAG with Database

Combine database queries with RAG:

```python
# 1. Query database for structured data
db_results = execute_query(session_id, query)

# 2. Use RAG for unstructured data
rag_results = search_knowledge_base(question)

# 3. Combine results
combined = merge_results(db_results, rag_results)

# 4. Generate response
response = llm.generate(combined)
```

### Pattern 2: Multi-Database Queries

Query multiple databases:

```python
# Connect to multiple databases
mysql_session = connect_database(mysql_config)
postgres_session = connect_database(postgres_config)

# Query each database
mysql_data = execute_query(mysql_session, mysql_query)
postgres_data = execute_query(postgres_session, postgres_query)

# Merge results
merged = merge_data(mysql_data, postgres_data)
```

### Pattern 3: Streaming Results

Stream large result sets:

```python
# Execute query with pagination
offset = 0
batch_size = 100

while True:
    query = f"SELECT * FROM users LIMIT {batch_size} OFFSET {offset}"
    results = execute_query(session_id, query)

    if not results:
        break

    # Process batch
    process_batch(results)

    offset += batch_size
```

## Troubleshooting

### Issue: Connection Failed

**Symptoms**: Cannot connect to database

**Solutions**:
1. Verify database credentials
2. Check network connectivity
3. Ensure API server is accessible
4. Check firewall rules

### Issue: Query Timeout

**Symptoms**: Queries take too long

**Solutions**:
1. Add indexes to tables
2. Optimize SQL queries
3. Increase timeout setting
4. Use pagination

### Issue: Memory Errors

**Symptoms**: Out of memory errors

**Solutions**:
1. Limit result set size
2. Use streaming for large datasets
3. Implement pagination
4. Increase memory allocation

## Resources

- [Dify Documentation](https://docs.dify.ai/)
- [API Reference](../http-api/API_REFERENCE.md)
- [Deployment Guide](../http-api/DEPLOYMENT.md)

## Support

For integration issues:
- GitHub Issues: https://github.com/Anarkh-Lee/universal-db-mcp/issues
- Dify Community: https://discord.gg/dify
