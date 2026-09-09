# Medallia MCP Server

An MCP (Model Context Protocol) server that integrates with the **Medallia Query API** to enable AI applications to query customer feedback, customer profiles, and analytics.

## What is MCP?

The Model Context Protocol (MCP) is a standardized protocol that enables AI applications to interact with external tools, data sources, and resources. This server exposes:

- **Tools**: Functions to query Medallia data
- **Resources**: Connection status and metadata

## Prerequisites

- Node.js 20 or later
- npm or yarn
- Medallia account with API credentials (OAuth 2.0 token)

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file in the project root (you can copy `.env.example`) and set the following values:

```bash
cp .env.example .env
```

Then populate:

```bash
# Required: OAuth client credentials
MEDALLIA_CLIENT_ID="your_client_id_here"
MEDALLIA_CLIENT_SECRET="your_client_secret_here"

# Required for the token request endpoint
MEDALLIA_REPORTING_INSTANCE="instance.medallia.com"
MEDALLIA_TENANT_NAME="tenant"

# Optional: override the full token endpoint if needed
# MEDALLIA_OAUTH_TOKEN_URL="https://instance.medallia.com/oauth/tenant/token"

# Optional: GraphQL endpoint (defaults to https://api.medallia.com/v2/graphql)
MEDALLIA_API_ENDPOINT="https://api.medallia.com/v2/graphql"

# Optional: default verbatim fields for queryFeedback when verbatimFieldIds is omitted
# Comma-separated list or JSON array string
MEDALLIA_DEFAULT_VERBATIM_FIELD_IDS="q_comment,q_followup_comment"

# Optional: MCP transport mode (defaults to stdio)
# MCP_TRANSPORT="stdio"
#
# Optional: HTTP transport settings (used when MCP_TRANSPORT=http)
# MCP_HTTP_HOST="127.0.0.1"
# MCP_HTTP_PORT="3000"
# MCP_HTTP_PATH="/mcp"
#
# Optional: host/origin validation for non-loopback HTTP deployments
# Comma-separated hostnames, no scheme.
# MCP_ALLOWED_HOSTS="mcp.example.com"
# MCP_ALLOWED_ORIGINS="app.example.com,copilot.microsoft.com"
```

Notes:
- The server reads `.env` (and also `env` for compatibility) from the project root.
- Variable expansion is supported, so values like `MEDALLIA_OAUTH_TOKEN_URL=https://${MEDALLIA_REPORTING_INSTANCE}/oauth/${MEDALLIA_TENANT_NAME}/token` work.
- You can override the file path with `ENV_FILE` (for example `ENV_FILE=.env.local npm run dev`).

### Getting Medallia Credentials

1. Log into your Medallia Experience Cloud instance
2. Navigate to **Administration → API Credentials**
3. Create or retrieve your OAuth 2.0 client ID and client secret
4. Ensure your API account has the **Query API** capability enabled
5. Use the reporting instance and tenant values from your Medallia Experience Cloud environment to fetch an access token dynamically

See [Medallia Authentication Docs](https://developer.medallia.com/medallia-apis/reference/authentication) for detailed instructions.

## Development

Run the server in development mode with live TypeScript compilation:

```bash
npm run dev
```

## Building

Build the TypeScript to JavaScript:

```bash
npm run build
```

## Production

Run the compiled server:

```bash
npm start
```

### Remote HTTP transport (for online MCP access)

The server now supports Streamable HTTP transport in addition to stdio.

```bash
MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_PORT=3000 npm start
```

This exposes the MCP endpoint at:

```text
http://<host>:3000/mcp
```

Notes:
- `stdio` remains the default transport for local IDE integrations.
- On loopback hosts (`localhost`, `127.0.0.1`, `::1`), localhost host/origin checks are enabled automatically.
- On non-loopback hosts, set `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` to enable host/origin validation.

## Testing

Test the server without Medallia credentials (will show graceful error handling):

```bash
npm run build
node test-medallia.js
```

To test with actual Medallia data:

```bash
MEDALLIA_API_TOKEN="your_token" node test-medallia.js
```

## Features

### Tools

#### 1. `getPrograms`
List available Experience Programs in your Medallia tenant.

**Parameters:**
- `limit` (optional, number): Number of programs to return (default: 10)

**Returns:** JSON with program metadata including name, status, response count, creation date

**Example:**
```
Tool: getPrograms
Parameters: { limit: 5 }
```

#### 2. `queryFeedback`
Query feedback records with optional filtering by date range and field selection.

**Parameters:**
- `limit` (optional, number): Records per page (default: 10)
- `dateFrom` (optional, string): Filter from date (ISO 8601)
- `dateTo` (optional, string): Filter to date (ISO 8601)
- `programId` (optional, string): Filter by Experience Program ID
- `fieldIds` (optional, string[]): Field IDs to return per feedback record (any field type supported by your Medallia tenant)
  - If omitted, the tool uses `MEDALLIA_DEFAULT_VERBATIM_FIELD_IDS` from `.env` when set.

Use `getFieldCatalog` to discover available field IDs for your tenant.

**Field Data Types:** The response includes `fieldData` with support for StringFieldData and CommentFieldData types from Medallia's GraphQL schema. Additional field types can be queried and will be returned based on your tenant configuration.

**Returns:** JSON with feedback nodes, total count, pagination info, and `fieldData` per node when requested (or when default fields are configured in `.env`)

**Example:**
```
Tool: queryFeedback
Parameters: {
  limit: 20,
  dateFrom: "2024-01-01",
  dateTo: "2024-12-31",
  fieldIds: ["q_comment", "q_followup_comment"]
}
```

#### 3. `queryCustomers`
Query customer profiles from Medallia CX Profiles (if enabled).

**Parameters:**
- `limit` (optional, number): Number of customers (default: 10)
- `firstName` (optional, string): Filter by first name
- `email` (optional, string): Filter by email

**Returns:** JSON with customer data (ID, email, name, phone) and pagination

**Example:**
```
Tool: queryCustomers
Parameters: { limit: 10 }
```

#### 4. `getAggregates`
Calculate aggregate metrics from feedback data.

**Parameters:**
- `metric` (required, enum): Type of aggregation
  - `count` - Count of records
  - `average` - Average value
  - `sum` - Sum of values
  - `customCalculation`
  - `custom`
  - `countUnique`
  - `bucketCount`
  - `percentage`
  - `topicPercentage`
  - `globalRecordsTopicPercentage`
  - `topicImpact`
  - `scaledTopicImpact`
  - `sentimentCount`
  - `sentimentPercentage`
  - `sentimentNetPercentage`
  - `regressionBeta`
  - `regressionCorrelation`
  - `segmentAverage`
  - `segmentPercentile`
  - `filtered`
  - `sumOfProduct`
  - `min` / `max` (legacy compatibility)
- `fieldId` (optional, string): Field to aggregate (default: configured default aggregate field)
- `secondaryFieldId` (optional, string): Required for `sumOfProduct` unless custom metric config is provided
- `customCalculationName` (optional, string): Required for `customCalculation` unless custom metric config is provided
- `metricConfigGraphQL` (optional, string): Raw GraphQL metric body for advanced metrics
- `dateFrom` (optional, string): Filter from date (ISO 8601)
- `dateTo` (optional, string): Filter to date (ISO 8601)

**Returns:** JSON with metric result and applied filters

Use `getFieldCatalog` to discover the current valid field IDs for your tenant.

**Example:**
```
Tool: getAggregates
Parameters: {
  metric: "average",
  fieldId: "q_sgb_ltr_scale11",
  dateFrom: "2024-01-01"
}
```

**Advanced `metricConfigGraphQL` examples (by metric):**

```js
// count (plain record count)
{ metric: "count" }

// count on a field
{ metric: "count", fieldId: "q_sgb_ltr_scale11" }

// average / sum / countUnique / custom
{ metric: "average", fieldId: "q_sgb_ltr_scale11" }
{ metric: "sum", fieldId: "q_sgb_ltr_scale11" }
{ metric: "countUnique", fieldId: "q_sgb_ltr_scale11" }
{ metric: "custom", fieldId: "r_bp_branch_net_promoter_score" }

// customCalculation (requires customCalculationName)
{
  metric: "customCalculation",
  fieldId: "q_sgb_ltr_scale11",
  customCalculationName: "bp_count"
}

// sumOfProduct (two fields)
{
  metric: "sumOfProduct",
  fieldId: "q_driver_1",
  secondaryFieldId: "q_driver_2"
}

// min / max (legacy compatibility)
{ metric: "min", fieldId: "q_sgb_ltr_scale11" }
{ metric: "max", fieldId: "q_sgb_ltr_scale11" }
```

```js
// Advanced metrics use metricConfigGraphQL.
// Pass the metric body exactly as required by your Medallia tenant/schema.

// bucketCount
{ metric: "bucketCount", metricConfigGraphQL: 'fieldFilter: { fieldIds: ["e_responsedate"], gte: "2026-01-01", lt: "2026-02-01" }' }

// percentage (Medallia docs note: aggregateTable-focused metric)
{ metric: "percentage", metricConfigGraphQL: 'axis: ROW' }

// topic metrics
{ metric: "topicPercentage", metricConfigGraphQL: 'topic: { sentiment: POSITIVE }' }
{ metric: "globalRecordsTopicPercentage", metricConfigGraphQL: 'topic: { sentiment: POSITIVE }' }
{ metric: "topicImpact", metricConfigGraphQL: 'metric: { average: { field: { id: "q_sgb_ltr_scale11" } } }' }
{ metric: "scaledTopicImpact", metricConfigGraphQL: 'metric: { average: { field: { id: "q_sgb_ltr_scale11" } } }' }

// sentiment metrics
{ metric: "sentimentCount", metricConfigGraphQL: 'sentiments: [POSITIVE, STRONGLY_POSITIVE]' }
{ metric: "sentimentPercentage", metricConfigGraphQL: 'sentiments: [POSITIVE, STRONGLY_POSITIVE]' }
{ metric: "sentimentNetPercentage", metricConfigGraphQL: '{}' }

// regression metrics
{ metric: "regressionBeta", metricConfigGraphQL: 'dependentField: { id: "q_sgb_ltr_scale11" }, independentFields: [{ id: "q_driver_1" }, { id: "q_driver_2" }]' }
{ metric: "regressionCorrelation", metricConfigGraphQL: 'dependentField: { id: "q_sgb_ltr_scale11" }, independentFields: [{ id: "q_driver_1" }, { id: "q_driver_2" }]' }

// segment metrics
{ metric: "segmentAverage", metricConfigGraphQL: 'metric: { average: { field: { id: "q_sgb_ltr_scale11" } } }, segment: { field: { id: "e_unitid" }, key: "12345" }' }
{ metric: "segmentPercentile", metricConfigGraphQL: 'metric: { average: { field: { id: "q_sgb_ltr_scale11" } } }, percentile: 90, segment: { field: { id: "e_unitid" }, key: "12345" }' }

// filtered (wrapper metric)
{ metric: "filtered", metricConfigGraphQL: 'filter: { fieldIds: ["e_responsedate"], gte: "2026-01-01", lt: "2026-02-01" }, metric: { average: { field: { id: "q_sgb_ltr_scale11" } } }' }
```

For advanced metrics, validate exact shape with your tenant using `getFieldCatalog` + small trial queries, since Medallia setup/custom modules can affect accepted metric payloads.

### Resources

#### `medallia-status`
**URI:** `medallia://connection-status`

Provides real-time status of the Medallia API connection.

**Returns:** JSON with:
- `connected` - Whether GraphQL client is initialized
- `authenticated` - Whether API token is configured
- `endpoint` - Configured API endpoint
- `status` - Human-readable status message
- `timestamp` - Current time

## Architecture

```
src/
├── index.ts              # Main server with Medallia tools & resources

test-medallia.js         # Integration test client
test-client.js           # Generic MCP test harness
```

## Medallia Query API

This server wraps the [Medallia Query API](https://developer.medallia.com/medallia-apis/reference/query-api-overview), which is a **GraphQL API** for accessing customer feedback, analytics, and metadata.

### Key Concepts

- **Feedback & Invitations**: Records of survey responses and events
- **Customers**: CX Profile data (requires CX Profiles add-on)
- **Aggregates**: Calculated metrics (NPS, averages, counts, etc.)
- **Programs**: Experience Programs define the data schema
- **Fields**: Individual survey questions and data fields

### Rate Limits

The Medallia Query API has the following limits:
- 70 requests per second
- 975,000 requests per 24-hour window
- 3,000,000 cost-unit limit per query

See [Rate Limits](https://developer.medallia.com/medallia-apis/reference/query-api-overview#rate-limits) for details.

## Error Handling

The server gracefully handles errors:

- **Missing credentials**: Returns clear error message instructing user to set `MEDALLIA_API_TOKEN`
- **Invalid queries**: Returns GraphQL error from Medallia API
- **Network issues**: Returns timeout or connection error

Example error response:
```json
{
  "content": [
    {
      "type": "text",
      "text": "Error querying programs: MEDALLIA_API_TOKEN environment variable not set."
    }
  ]
}
```

## Next Steps

To extend this server:

- Add more GraphQL queries for specific use cases
- Implement caching of frequently-accessed data
- Add more aggregate calculation types
- Create custom tools for your specific data schema
- Add prompt templates for common analyses

## Learn More

- [Medallia Query API Documentation](https://developer.medallia.com/medallia-apis/reference/query-api-overview)
- [Medallia Authentication Guide](https://developer.medallia.com/medallia-apis/reference/authentication)
- [MCP Documentation](https://modelcontextprotocol.io/)
- [GraphQL Basics](https://graphql.org/learn/)

## Troubleshooting

### "MEDALLIA_API_TOKEN environment variable not set"

This is expected when the environment variable is not configured. Set it before running:
```bash
export MEDALLIA_API_TOKEN="your_token"
node dist/index.js
```

### "Query cost exceeds limit"

Your GraphQL query is too expensive. Try:
- Reducing the `limit` parameter
- Adding more specific filters
- Splitting into multiple queries

### Connection refused

Check that:
- Your API endpoint is correct
- Your OAuth token is valid and not expired
- Your network can reach `api.medallia.com`
