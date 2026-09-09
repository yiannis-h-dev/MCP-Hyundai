# Medallia MCP Server Setup Guide

## Quick Start

### 1. Get Medallia Credentials

1. Log into your Medallia Experience Cloud instance
2. Navigate to **Administration → API Credentials** (or **Integration → API Management**)
3. Create a new OAuth 2.0 application or retrieve your client ID and client secret
4. Note the **reporting instance** and **tenant name** used for the OAuth token request
5. Verify your API user has the **Query API** capability enabled

### 2. Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` and add your OAuth client credentials:

```bash
MEDALLIA_CLIENT_ID=your_client_id_here
MEDALLIA_CLIENT_SECRET=your_client_secret_here
MEDALLIA_REPORTING_INSTANCE=instance.medallia.com
MEDALLIA_TENANT_NAME=tenant
MEDALLIA_DEFAULT_VERBATIM_FIELD_IDS=q_comment,q_followup_comment
```

Use `getFieldCatalog` after startup to confirm which `defaultVerbatimFieldIds` were loaded from `.env`.

### 3. Build and Run

```bash
npm run build
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

### 4. Verify Connection

Test the connection using the test client:

```bash
node test-medallia.js
```

You should see confirmation that the server is authenticated and ready to query Medallia data.

## Using with Claude Desktop

### Step 1: Update Claude Desktop Config

Edit your Claude Desktop configuration file:

**Mac/Linux:** `~/.config/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add this MCP server:

```json
{
  "mcpServers": {
    "medallia": {
      "command": "node",
      "args": ["/path/to/MCP/dist/index.js"],
      "env": {
        "MEDALLIA_API_TOKEN": "your_token_here",
        "MEDALLIA_API_ENDPOINT": "https://api.medallia.com/v2/graphql"
      }
    }
  }
}
```

Replace `/path/to/MCP` with the actual path to this project.

### Step 2: Restart Claude Desktop

Close and reopen Claude Desktop. The Medallia tools should now be available.

### Step 3: Start Asking Questions

Try queries like:

- "What are the top-performing Experience Programs?"
- "Show me the average NPS score for last month"
- "List customers and their satisfaction metrics"
- "Get feedback records from January 2024"

## Using with VS Code

### Option 1: MCP Inspector (Recommended for Development)

The MCP Inspector provides a visual interface for testing:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

This opens `http://localhost:3000` with a GraphQL-like interface for testing tools.

### Option 2: Direct Testing

Use the included test client:

```bash
node test-medallia.js
```

## Running as a Remote HTTP MCP Server

To expose this server online for Copilot-compatible or other MCP clients:

```bash
MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_PORT=3000 npm start
```

Default endpoint path is:

```text
/mcp
```

Recommended for public/non-loopback deployments:
- Set `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` (comma-separated hostnames).
- Put the server behind HTTPS at your reverse proxy/load balancer.

## Troubleshooting

### Issue: "MEDALLIA_API_TOKEN not set"

**Solution:** Ensure the environment variable is exported before starting:

```bash
export MEDALLIA_API_TOKEN="your_token"
npm start
```

Or add it to your `.env` file and use a tool like `dotenv-cli`:

```bash
npm install -D dotenv-cli
npx dotenv -e .env npm start
```

### Issue: "GraphQL Error: Unauthorized"

**Possible causes:**
- Token is expired or invalid
- Your API user doesn't have Query API capability enabled
- The token is for the wrong Medallia instance

**Solution:**
1. Verify your token in Medallia Administration
2. Check that your API user has Query API access
3. Ensure you're using the correct tenant's credentials

### Issue: "Cost exceeds limit"

**Cause:** Your GraphQL query is too expensive (hitting rate limits)

**Solution:**
- Use smaller `limit` values in tools
- Add more specific filters to reduce dataset size
- Break complex queries into multiple smaller ones

### Issue: "Cannot find module 'graphql-request'"

**Solution:**

```bash
npm install
npm run build
```

## API Rate Limits

Be aware of Medallia's rate limits:

- **70 requests/second**
- **975,000 requests/24 hours**
- **3,000,000 cost-units per query**

See [Medallia Docs](https://developer.medallia.com/medallia-apis/reference/query-api-overview#rate-limits) for details.

## Common Queries

### Get Average NPS for Last Quarter

```
Tool: getAggregates
metric: "average"
fieldId: "e_ltr"
dateFrom: "2024-01-01"
dateTo: "2024-03-31"
```

### List Recent Feedback

```
Tool: queryFeedback
limit: 50
dateFrom: "2024-08-01"
verbatimFieldIds: ["q_comment"]
```

### Get Program Details

```
Tool: getPrograms
limit: 10
```

### Find High-Value Customers

```
Tool: queryCustomers
limit: 20
```

## Advanced Configuration

### Custom GraphQL Endpoint

If your Medallia instance uses a custom endpoint:

```bash
export MEDALLIA_API_ENDPOINT="https://custom.medallia.com/graphql"
npm start
```

### Request Logging

Modify `src/index.ts` to add logging:

```typescript
const medallia = new GraphQLClient(MEDALLIA_API_ENDPOINT, {
  headers: { Authorization: `Bearer ${MEDALLIA_API_TOKEN}` },
  fetch: async (url, options) => {
    console.log("GraphQL Request:", options.body);
    return fetch(url, options);
  },
});
```

## Support & Resources

- **Medallia Query API Docs:** https://developer.medallia.com/medallia-apis/reference/query-api-overview
- **Medallia Authentication:** https://developer.medallia.com/medallia-apis/reference/authentication
- **GraphQL Documentation:** https://graphql.org/learn/
- **MCP Documentation:** https://modelcontextprotocol.io/
