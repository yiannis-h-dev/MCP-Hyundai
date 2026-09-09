import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { JSONRPCMessage, Transport, TransportSendOptions } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { GraphQLClient } from "graphql-request";
import { config as loadEnv } from "dotenv";
import { expand as expandEnv } from "dotenv-expand";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";

class CompatibleStdioTransport implements Transport {
  private buffer = Buffer.alloc(0);
  private started = false;
  private closed = false;
  private responseFormat: "content-length" | "newline" = "content-length";

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly onData = (chunk: Buffer) => {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    } catch (error) {
      this.onerror?.(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  };

  async start() {
    if (this.started) {
      throw new Error("CompatibleStdioTransport already started");
    }
    this.started = true;
    process.stdin.on("data", this.onData);
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    process.stdin.off("data", this.onData);
    if (process.stdin.listenerCount("data") === 0) {
      process.stdin.pause();
    }
    this.buffer = Buffer.alloc(0);
    this.onclose?.();
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions) {
    const json = JSON.stringify(message);
    const payload =
      this.responseFormat === "content-length"
        ? `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`
        : `${json}\n`;

    return new Promise<void>((resolve, reject) => {
      if (this.closed) {
        reject(new Error("CompatibleStdioTransport is closed"));
        return;
      }
      process.stdout.write(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private processBuffer() {
    while (this.buffer.length > 0) {
      const firstLineEnd = this.buffer.indexOf("\n");
      if (firstLineEnd === -1) {
        return;
      }

      const firstLine = this.buffer
        .toString("utf8", 0, firstLineEnd)
        .replace(/\r$/, "");
      const isHeaderFormat =
        firstLine.includes(":") && !firstLine.trimStart().startsWith("{");

      if (isHeaderFormat) {
        const headerEndCRLF = this.buffer.indexOf("\r\n\r\n");
        const headerEndLF = this.buffer.indexOf("\n\n");
        const hasCRLFHeader = headerEndCRLF !== -1;
        const headerEnd = hasCRLFHeader
          ? headerEndCRLF
          : headerEndLF !== -1
            ? headerEndLF
            : -1;
        if (headerEnd === -1) {
          return;
        }

        const headerSeparatorLength = hasCRLFHeader ? 4 : 2;
        const headerText = this.buffer.toString("utf8", 0, headerEnd);
        const contentLengthHeader = headerText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => /^content-length\s*:/i.test(line));

        if (!contentLengthHeader) {
          throw new Error("Missing Content-Length header in framed MCP message");
        }

        const contentLength = Number(contentLengthHeader.split(":")[1]?.trim());
        if (!Number.isFinite(contentLength) || contentLength < 0) {
          throw new Error("Invalid Content-Length header value");
        }

        const bodyStart = headerEnd + headerSeparatorLength;
        const bodyEnd = bodyStart + contentLength;
        if (this.buffer.length < bodyEnd) {
          return;
        }

        const body = this.buffer.toString("utf8", bodyStart, bodyEnd);
        this.buffer = this.buffer.subarray(bodyEnd);
        this.responseFormat = "content-length";
        this.onmessage?.(JSON.parse(body) as JSONRPCMessage);
        continue;
      }

      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer
        .toString("utf8", 0, newlineIndex)
        .replace(/\r$/, "")
        .trim();
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (!line) {
        continue;
      }

      this.responseFormat = "newline";
      this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
    }
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const envFileFromConfig = process.env.ENV_FILE
  ? resolve(process.cwd(), process.env.ENV_FILE)
  : null;
const envFileCandidates = Array.from(
  new Set(
    [
      envFileFromConfig,
      resolve(process.cwd(), ".env"),
      resolve(process.cwd(), "env"),
      resolve(moduleDir, "../.env"),
      resolve(moduleDir, "../env"),
    ].filter((path): path is string => !!path)
  )
);

for (const envFilePath of envFileCandidates) {
  const result = loadEnv({ path: envFilePath });
  if (!result.error) {
    expandEnv({ parsed: result.parsed });
    break;
  }
  if ((result.error as NodeJS.ErrnoException).code !== "ENOENT") {
    console.error(
      `[Medallia MCP Server] Failed to load environment file at ${envFilePath}: ${result.error.message}`
    );
  }
}

// Configuration from environment variables
const MEDALLIA_API_TOKEN = process.env.MEDALLIA_API_TOKEN;
const MEDALLIA_CLIENT_ID = process.env.MEDALLIA_CLIENT_ID;
const MEDALLIA_CLIENT_SECRET = process.env.MEDALLIA_CLIENT_SECRET;
const MEDALLIA_REPORTING_INSTANCE =
  process.env.MEDALLIA_REPORTING_INSTANCE || "instance.medallia.com";
const MEDALLIA_TENANT_NAME = process.env.MEDALLIA_TENANT_NAME || "tenant";
const MEDALLIA_API_ENDPOINT =
  process.env.MEDALLIA_API_ENDPOINT ||
  "https://api.medallia.com/v2/graphql";
const MEDALLIA_OAUTH_TOKEN_URL =
  process.env.MEDALLIA_OAUTH_TOKEN_URL ||
  `https://${MEDALLIA_REPORTING_INSTANCE}/oauth/${MEDALLIA_TENANT_NAME}/token`;
const MEDALLIA_DATE_FIELD_ID =
  process.env.MEDALLIA_DATE_FIELD_ID || "e_responsedate";
const MEDALLIA_DEFAULT_AGGREGATE_FIELD_ID =
  process.env.MEDALLIA_DEFAULT_AGGREGATE_FIELD_ID || "e_ltr";
const MEDALLIA_DEFAULT_VERBATIM_FIELD_IDS = parseDefaultVerbatimFieldIds();
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || "stdio").trim().toLowerCase();
const MCP_HTTP_HOST = (process.env.MCP_HTTP_HOST || "127.0.0.1").trim();
const MCP_HTTP_PORT = parsePort(process.env.MCP_HTTP_PORT);
const MCP_HTTP_PATH = normalizeHttpPath(process.env.MCP_HTTP_PATH || "/mcp");
const MCP_ALLOWED_HOSTS = parseCommaSeparatedValues(process.env.MCP_ALLOWED_HOSTS);
const MCP_ALLOWED_ORIGINS = parseCommaSeparatedValues(process.env.MCP_ALLOWED_ORIGINS);

type MedalliaFieldDefinition = {
  id: string;
  name: string;
  description: string;
  usage: Array<"dateFilter" | "aggregation">;
};

function parseCommaSeparatedValues(rawValue: string | undefined): string[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return [];
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parsePort(rawValue: string | undefined): number {
  const parsed = Number.parseInt(rawValue || "3000", 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `Invalid MCP_HTTP_PORT value: ${rawValue}. Expected an integer between 1 and 65535.`
    );
  }
  return parsed;
}

function normalizeHttpPath(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return "/mcp";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

const DEFAULT_MEDALLIA_FIELDS: MedalliaFieldDefinition[] = [
  {
    id: "e_creationdate",
    name: "Creation Date",
    description: "Feedback creation timestamp (ISO 8601 format).",
    usage: ["dateFilter"],
  },
  {
    id: "e_ltr",
    name: "Likelihood to Recommend",
    description: "LTR / NPS-style recommendation score field.",
    usage: ["aggregation"],
  },
];

function parseFieldCatalog(): MedalliaFieldDefinition[] {
  const raw = process.env.MEDALLIA_FIELDS_JSON;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_MEDALLIA_FIELDS;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("MEDALLIA_FIELDS_JSON must be a JSON array.");
    }

    const definitions = parsed.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw new Error(`Entry ${index} must be an object.`);
      }

      const maybeId = (item as { id?: unknown }).id;
      const maybeName = (item as { name?: unknown }).name;
      const maybeDescription = (item as { description?: unknown }).description;
      const maybeUsage = (item as { usage?: unknown }).usage;

      if (typeof maybeId !== "string" || maybeId.trim().length === 0) {
        throw new Error(`Entry ${index} has invalid id.`);
      }
      if (typeof maybeName !== "string" || maybeName.trim().length === 0) {
        throw new Error(`Entry ${index} has invalid name.`);
      }
      if (
        typeof maybeDescription !== "string" ||
        maybeDescription.trim().length === 0
      ) {
        throw new Error(`Entry ${index} has invalid description.`);
      }
      if (!Array.isArray(maybeUsage)) {
        throw new Error(`Entry ${index} has invalid usage.`);
      }

      const usage = maybeUsage.filter(
        (value): value is "dateFilter" | "aggregation" =>
          value === "dateFilter" || value === "aggregation"
      );

      if (usage.length === 0) {
        throw new Error(`Entry ${index} must include at least one usage value.`);
      }

      return {
        id: maybeId,
        name: maybeName,
        description: maybeDescription,
        usage,
      };
    });

    return definitions;
  } catch (error) {
    console.error(
      `[Medallia MCP Server] Invalid MEDALLIA_FIELDS_JSON. Using defaults. ${error instanceof Error ? error.message : String(error)}`
    );
    return DEFAULT_MEDALLIA_FIELDS;
  }
}

function parseDefaultVerbatimFieldIds(): string[] {
  const raw = process.env.MEDALLIA_DEFAULT_VERBATIM_FIELD_IDS;
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  const normalized = raw.trim();
  if (normalized.startsWith("[")) {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("must be a JSON array of strings.");
      }

      return parsed
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    } catch (error) {
      console.error(
        `[Medallia MCP Server] Invalid MEDALLIA_DEFAULT_VERBATIM_FIELD_IDS JSON. ` +
          `Use a comma-separated string or JSON string array. ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  return normalized
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const MEDALLIA_FIELDS = parseFieldCatalog();
const MEDALLIA_FIELDS_BY_ID = new Map(
  MEDALLIA_FIELDS.map((field) => [field.id, field] as const)
);
const SUPPORTED_AGGREGATION_METRICS = [
  "average",
  "sum",
  "count",
  "customCalculation",
  "custom",
  "countUnique",
  "bucketCount",
  "percentage",
  "topicPercentage",
  "globalRecordsTopicPercentage",
  "topicImpact",
  "scaledTopicImpact",
  "sentimentCount",
  "sentimentPercentage",
  "sentimentNetPercentage",
  "regressionBeta",
  "regressionCorrelation",
  "segmentAverage",
  "segmentPercentile",
  "filtered",
  "sumOfProduct",
] as const;
const LEGACY_AGGREGATION_METRICS = ["min", "max"] as const;
const ALL_AGGREGATION_METRICS = [
  ...SUPPORTED_AGGREGATION_METRICS,
  ...LEGACY_AGGREGATION_METRICS,
] as const;
type AggregationMetric = (typeof ALL_AGGREGATION_METRICS)[number];
const FIELD_REQUIRED_METRICS = new Set<AggregationMetric>([
  "average",
  "sum",
  "countUnique",
  "custom",
  "min",
  "max",
]);
const COMPLEX_METRICS_REQUIRING_CONFIG = new Set<AggregationMetric>([
  "bucketCount",
  "percentage",
  "topicPercentage",
  "globalRecordsTopicPercentage",
  "topicImpact",
  "scaledTopicImpact",
  "sentimentCount",
  "sentimentPercentage",
  "sentimentNetPercentage",
  "regressionBeta",
  "regressionCorrelation",
  "segmentAverage",
  "segmentPercentile",
  "filtered",
]);

function formatFieldCatalog(): string {
  return MEDALLIA_FIELDS.map(
    (field) =>
      `- ${field.id}: ${field.name} (${field.usage.join(", ")}) - ${field.description}`
  ).join("\n");
}

function isKnownAggregateFieldId(fieldId: string): boolean {
  const definition = MEDALLIA_FIELDS_BY_ID.get(fieldId);
  return !!definition && definition.usage.includes("aggregation");
}

function escapeGraphQLString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildMetricDefinition(args: {
  metric: AggregationMetric;
  fieldId?: string;
  secondaryFieldId?: string;
  customCalculationName?: string;
  metricConfigGraphQL?: string;
}): { metricDefinition?: string; error?: string } {
  const {
    metric,
    fieldId,
    secondaryFieldId,
    customCalculationName,
    metricConfigGraphQL,
  } = args;

  if (metricConfigGraphQL && metricConfigGraphQL.trim().length > 0) {
    return {
      metricDefinition: `${metric}: { ${metricConfigGraphQL.trim()} }`,
    };
  }

  if (FIELD_REQUIRED_METRICS.has(metric) && !fieldId) {
    return {
      error: `Metric "${metric}" requires fieldId.`,
    };
  }

  if (COMPLEX_METRICS_REQUIRING_CONFIG.has(metric)) {
    return {
      error:
        `Metric "${metric}" requires metricConfigGraphQL. ` +
        "See Medallia Query API aggregation metric definitions.",
    };
  }

  const escapedFieldId = fieldId ? escapeGraphQLString(fieldId) : undefined;
  const escapedSecondaryFieldId = secondaryFieldId
    ? escapeGraphQLString(secondaryFieldId)
    : undefined;
  const escapedCustomCalculationName = customCalculationName
    ? escapeGraphQLString(customCalculationName)
    : undefined;

  switch (metric) {
    case "count":
      return {
        metricDefinition: escapedFieldId
          ? `count: { field: { id: "${escapedFieldId}" } }`
          : "count: {}",
      };
    case "average":
      return { metricDefinition: `average: { field: { id: "${escapedFieldId}" } }` };
    case "sum":
      return { metricDefinition: `sum: { field: { id: "${escapedFieldId}" } }` };
    case "countUnique":
      return {
        metricDefinition: `countUnique: { field: { id: "${escapedFieldId}" } }`,
      };
    case "custom":
      return { metricDefinition: `custom: { field: { id: "${escapedFieldId}" } }` };
    case "customCalculation":
      if (!escapedFieldId || !escapedCustomCalculationName) {
        return {
          error: 'Metric "customCalculation" requires fieldId and customCalculationName.',
        };
      }
      return {
        metricDefinition:
          `customCalculation: { name: "${escapedCustomCalculationName}", ` +
          `field: { id: "${escapedFieldId}" } }`,
      };
    case "sumOfProduct":
      if (!escapedFieldId || !escapedSecondaryFieldId) {
        return {
          error:
            'Metric "sumOfProduct" requires fieldId and secondaryFieldId, or metricConfigGraphQL.',
        };
      }
      return {
        metricDefinition:
          `sumOfProduct: { field: { id: "${escapedFieldId}" }, ` +
          `otherField: { id: "${escapedSecondaryFieldId}" } }`,
      };
    case "min":
      return { metricDefinition: `min: { field: { id: "${escapedFieldId}" } }` };
    case "max":
      return { metricDefinition: `max: { field: { id: "${escapedFieldId}" } }` };
    default:
      return {
        error: `Unsupported metric "${metric}".`,
      };
  }
}

let cachedAccessToken: string | null = null;
let tokenExpiryEpochMs = 0;

function hasMedalliaCredentials(): boolean {
  return !!(
    (MEDALLIA_API_TOKEN && MEDALLIA_API_TOKEN.length > 0) ||
    (MEDALLIA_CLIENT_ID &&
      MEDALLIA_CLIENT_ID.length > 0 &&
      MEDALLIA_CLIENT_SECRET &&
      MEDALLIA_CLIENT_SECRET.length > 0)
  );
}

async function getAccessToken(): Promise<string | null> {
  if (MEDALLIA_API_TOKEN && MEDALLIA_API_TOKEN.length > 0) {
    return MEDALLIA_API_TOKEN;
  }

  if (!MEDALLIA_CLIENT_ID || !MEDALLIA_CLIENT_SECRET) {
    return null;
  }

  const now = Date.now();
  if (cachedAccessToken && now < tokenExpiryEpochMs - 60_000) {
    return cachedAccessToken;
  }

  const authHeader = `Basic ${Buffer.from(
    `${MEDALLIA_CLIENT_ID}:${MEDALLIA_CLIENT_SECRET}`
  ).toString("base64")}`;

  const response = await fetch(MEDALLIA_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });

  const payload = (await response.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    const reason =
      payload.error_description || payload.error || response.statusText;
    throw new Error(
      `Failed to fetch Medallia OAuth token${reason ? `: ${reason}` : ""}`
    );
  }

  cachedAccessToken = payload.access_token;
  tokenExpiryEpochMs =
    Date.now() + (Number(payload.expires_in) || 3600) * 1000;

  return cachedAccessToken;
}

async function requestMedallia<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const accessToken = await getAccessToken();

  if (!accessToken) {
    throw new Error(
      "Medallia credentials not configured. Set MEDALLIA_CLIENT_ID and MEDALLIA_CLIENT_SECRET, or MEDALLIA_API_TOKEN."
    );
  }

  const client = new GraphQLClient(MEDALLIA_API_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return client.request<T>(query, variables);
}

type ConnectionStatus = {
  connected: boolean;
  authenticated: boolean;
  endpoint: string;
  oauthTokenUrl: string;
  timestamp: string;
  status: string;
  error?: string;
};

async function getConnectionStatus(): Promise<ConnectionStatus> {
  const timestamp = new Date().toISOString();

  if (!hasMedalliaCredentials()) {
    return {
      connected: false,
      authenticated: false,
      endpoint: MEDALLIA_API_ENDPOINT,
      oauthTokenUrl: MEDALLIA_OAUTH_TOKEN_URL,
      timestamp,
      status:
        "Not configured - set MEDALLIA_CLIENT_ID and MEDALLIA_CLIENT_SECRET (or MEDALLIA_API_TOKEN)",
    };
  }

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return {
        connected: false,
        authenticated: false,
        endpoint: MEDALLIA_API_ENDPOINT,
        oauthTokenUrl: MEDALLIA_OAUTH_TOKEN_URL,
        timestamp,
        status: "Authentication failed",
        error:
          "No access token received. Check MEDALLIA_CLIENT_ID/MEDALLIA_CLIENT_SECRET or MEDALLIA_API_TOKEN.",
      };
    }
  } catch (error) {
    return {
      connected: false,
      authenticated: false,
      endpoint: MEDALLIA_API_ENDPOINT,
      oauthTokenUrl: MEDALLIA_OAUTH_TOKEN_URL,
      timestamp,
      status: "Authentication failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    await requestMedallia<{ __typename: string }>(
      `
        query MedalliaConnectionStatus {
          __typename
        }
      `
    );

    return {
      connected: true,
      authenticated: true,
      endpoint: MEDALLIA_API_ENDPOINT,
      oauthTokenUrl: MEDALLIA_OAUTH_TOKEN_URL,
      timestamp,
      status: "Connected",
    };
  } catch (error) {
    return {
      connected: false,
      authenticated: true,
      endpoint: MEDALLIA_API_ENDPOINT,
      oauthTokenUrl: MEDALLIA_OAUTH_TOKEN_URL,
      timestamp,
      status: "Authenticated but API query failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Create and configure the MCP server
function createMedalliaMcpServer() {
  const server = new McpServer({
    name: "medallia-mcp-server",
    version: "1.0.0",
  });

// Tool: Return known Medallia field IDs and descriptions
server.registerTool(
  "getFieldCatalog",
  {
    description:
      "Return known Medallia field IDs and descriptions for filters and aggregation.",
    inputSchema: z.object({}),
  },
  async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              fields: MEDALLIA_FIELDS,
              defaultDateFieldId: MEDALLIA_DATE_FIELD_ID,
              defaultAggregateFieldId: MEDALLIA_DEFAULT_AGGREGATE_FIELD_ID,
              defaultVerbatimFieldIds: MEDALLIA_DEFAULT_VERBATIM_FIELD_IDS,
              supportedAggregationMetrics: ALL_AGGREGATION_METRICS,
              summary: formatFieldCatalog(),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: List available Experience Programs
server.registerTool(
  "getPrograms",
  {
    description:
      "List available Experience Programs in Medallia tenant with metadata",
    inputSchema: z.object({
      limit: z
        .number()
        .optional()
        .describe("Number of programs to return (default: 10)"),
    }),
  },
  async ({ limit = 10 }) => {
    if (!hasMedalliaCredentials()) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Medallia credentials not configured. Set MEDALLIA_CLIENT_ID and MEDALLIA_CLIENT_SECRET, or MEDALLIA_API_TOKEN.",
          },
        ],
      };
    }

    try {
      const query = `
        query GetPrograms($first: Int!) {
          programs(first: $first) {
            nodes {
              id
              name
              description
              status
              type
              responsesCount
              createdOn
              createdBy
            }
          }
        }
      `;

      const data = await requestMedallia(query, { first: limit });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error querying programs: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Tool: Query feedback data
server.registerTool(
  "queryFeedback",
  {
    description:
      "Query feedback records from Medallia with optional filters, field selection, and pagination",
    inputSchema: z.object({
      programId: z
        .string()
        .optional()
        .describe("Filter by Experience Program ID"),
      limit: z
        .number()
        .optional()
        .describe("Number of records per page (default: 10)"),
      dateFrom: z
        .string()
        .optional()
        .describe("Filter records created from this date (ISO 8601)"),
      dateTo: z
        .string()
        .optional()
        .describe("Filter records created until this date (ISO 8601)"),
      fieldIds: z
        .array(z.string())
        .optional()
        .describe(
          "Field IDs to return per feedback record (any field type supported by your Medallia tenant). Defaults to MEDALLIA_DEFAULT_VERBATIM_FIELD_IDS from .env when omitted"
        ),
    }),
  },
  async ({ programId, limit = 10, dateFrom, dateTo, fieldIds }) => {
    if (!hasMedalliaCredentials()) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Medallia credentials not configured. Set MEDALLIA_CLIENT_ID and MEDALLIA_CLIENT_SECRET, or MEDALLIA_API_TOKEN.",
          },
        ],
      };
    }

    try {
      // Build filter if date range provided
      let filterConditions = [];
      if (dateFrom) {
        filterConditions.push(
          `{ fieldIds: ["${escapeGraphQLString(MEDALLIA_DATE_FIELD_ID)}"], gte: "${escapeGraphQLString(dateFrom)}" }`
        );
      }
      if (dateTo) {
        filterConditions.push(
          `{ fieldIds: ["${escapeGraphQLString(MEDALLIA_DATE_FIELD_ID)}"], lt: "${escapeGraphQLString(dateTo)}" }`
        );
      }

      // Use fieldIds if provided, otherwise fall back to env defaults
      const requestedFieldIds = fieldIds ?? MEDALLIA_DEFAULT_VERBATIM_FIELD_IDS;
      const escapedFieldIds = (requestedFieldIds)
        .map((fieldId: string) => fieldId.trim())
        .filter((fieldId: string) => fieldId.length > 0);
      
      // Build individual fieldData queries for each requested field
      const fieldsSelection =
        escapedFieldIds.length > 0
          ? escapedFieldIds
              .map((fieldId: string) => {
                const normalizedFieldId = fieldId.replace(/"/g, '\\"');
                return `${fieldId.replace(/[^a-zA-Z0-9_]/g, '_')}: fieldData(fieldId: "${normalizedFieldId}") {
                  values
                }`;
              })
              .join("\n                ")
          : "";


      const filterClause =
        filterConditions.length > 0
          ? `filter: { and: [${filterConditions.join(", ")}] }`
          : "";

      const query = `
        query QueryFeedback($first: Int!) {
          feedback(${filterClause} first: $first) {
            nodes {
              id
              ${fieldsSelection}
            }
            totalCount
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      const data = await requestMedallia(query, { first: limit });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error querying feedback: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Tool: Query customer profiles
server.registerTool(
  "queryCustomers",
  {
    description: "Query customer profiles from Medallia CX Profiles",
    inputSchema: z.object({
      limit: z
        .number()
        .optional()
        .describe("Number of customer records to return (default: 10)"),
      firstName: z
        .string()
        .optional()
        .describe("Filter by first name"),
      email: z
        .string()
        .optional()
        .describe("Filter by email address"),
    }),
  },
  async ({ limit = 10, firstName, email }) => {
    if (!hasMedalliaCredentials()) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Medallia credentials not configured. Set MEDALLIA_CLIENT_ID and MEDALLIA_CLIENT_SECRET, or MEDALLIA_API_TOKEN.",
          },
        ],
      };
    }

    try {
      const query = `
        query QueryCustomers($first: Int!) {
          customers(first: $first) {
            nodes {
              id
              email
              firstname
              lastname
              phone
            }
            totalCount
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      const data = await requestMedallia(query, { first: limit });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error querying customers: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Tool: Get aggregate metrics
server.registerTool(
  "getAggregates",
  {
    description:
      "Calculate Medallia aggregate metrics, including all documented aggregation metric types.",
    inputSchema: z.object({
      metric: z
        .enum(ALL_AGGREGATION_METRICS)
        .describe("Aggregation metric type."),
      fieldId: z
        .string()
        .optional()
        .describe(
          "Field ID to aggregate. Use getFieldCatalog to find valid field IDs."
        ),
      secondaryFieldId: z
        .string()
        .optional()
        .describe(
          "Optional second field ID (for example, sumOfProduct). Use getFieldCatalog for valid IDs."
        ),
      customCalculationName: z
        .string()
        .optional()
        .describe("Custom calculation name (required for customCalculation metric)."),
      metricConfigGraphQL: z
        .string()
        .optional()
        .describe(
          "Optional raw metric GraphQL body for advanced metrics (for example, filtered, topicImpact, regressionBeta)."
        ),
      dateFrom: z
        .string()
        .optional()
        .describe("Start date for filtering (ISO 8601)"),
      dateTo: z
        .string()
        .optional()
        .describe("End date for filtering (ISO 8601)"),
    }),
  },
  async ({
    metric,
    fieldId,
    secondaryFieldId,
    customCalculationName,
    metricConfigGraphQL,
    dateFrom,
    dateTo,
  }) => {
    if (!hasMedalliaCredentials()) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Medallia credentials not configured. Set MEDALLIA_CLIENT_ID and MEDALLIA_CLIENT_SECRET, or MEDALLIA_API_TOKEN.",
          },
        ],
      };
    }

    try {
      const resolvedFieldId = fieldId || MEDALLIA_DEFAULT_AGGREGATE_FIELD_ID;

      const shouldValidatePrimaryField =
        !!fieldId ||
        FIELD_REQUIRED_METRICS.has(metric) ||
        metric === "customCalculation" ||
        metric === "sumOfProduct";

      if (
        shouldValidatePrimaryField &&
        !isKnownAggregateFieldId(resolvedFieldId)
      ) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: Unknown aggregate fieldId "${resolvedFieldId}". ` +
                "Use getFieldCatalog to get valid field IDs.",
            },
          ],
        };
      }

      if (secondaryFieldId && !isKnownAggregateFieldId(secondaryFieldId)) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: Unknown secondaryFieldId "${secondaryFieldId}". ` +
                "Use getFieldCatalog to get valid field IDs.",
            },
          ],
        };
      }

      const metricDefinitionResult = buildMetricDefinition({
        metric,
        fieldId: resolvedFieldId,
        secondaryFieldId,
        customCalculationName,
        metricConfigGraphQL,
      });
      if (!metricDefinitionResult.metricDefinition) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${metricDefinitionResult.error || "Invalid metric definition."}`,
            },
          ],
        };
      }
      const metricDefinition = metricDefinitionResult.metricDefinition;

      // Build filter if date range provided
      let filterClause = "";
      if (dateFrom || dateTo) {
        const conditions = [];
        if (dateFrom)
          conditions.push(
            `{ fieldIds: ["${escapeGraphQLString(MEDALLIA_DATE_FIELD_ID)}"], gte: "${escapeGraphQLString(dateFrom)}" }`
          );
        if (dateTo)
          conditions.push(
            `{ fieldIds: ["${escapeGraphQLString(MEDALLIA_DATE_FIELD_ID)}"], lt: "${escapeGraphQLString(dateTo)}" }`
          );
        filterClause = `filter: { and: [${conditions.join(", ")}] }`;
      }

      const query = `
        query GetAggregates {
          result: aggregate(definition: {
            data: { source: FEEDBACK ${filterClause ? ", " + filterClause : ""} }
            metric: { ${metricDefinition} }
          })
        }
      `;

      const data = await requestMedallia(query);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                metric,
                fieldId: resolvedFieldId,
                secondaryFieldId,
                customCalculationName,
                result: (data as any).result,
                dateRange: { from: dateFrom, to: dateTo },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error calculating aggregates: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Resource: Field catalog
server.registerResource(
  "medallia-fields",
  "medallia://fields",
  {
    mimeType: "application/json",
    description: "Known Medallia fields with IDs and descriptions",
  },
  async () => {
    return {
      contents: [
        {
          uri: "medallia://fields",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              fields: MEDALLIA_FIELDS,
              defaults: {
                dateFieldId: MEDALLIA_DATE_FIELD_ID,
                aggregateFieldId: MEDALLIA_DEFAULT_AGGREGATE_FIELD_ID,
              },
              supportedAggregationMetrics: ALL_AGGREGATION_METRICS,
              guidance:
                "Use these field IDs for query filters and aggregate metrics.",
              summary: formatFieldCatalog(),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Resource: API Connection Status
server.registerResource(
  "medallia-status",
  "medallia://connection-status",
  {
    mimeType: "application/json",
    description: "Medallia API connection status and configuration",
  },
  async () => {
    const status = await getConnectionStatus();
    return {
      contents: [
        {
          uri: "medallia://connection-status",
          mimeType: "application/json",
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  }
);

  return server;
}

function logCredentialWarning() {
  if (!hasMedalliaCredentials()) {
    console.error(
      "[Medallia MCP Server] WARNING: Medallia credentials not set. Configure MEDALLIA_CLIENT_ID and MEDALLIA_CLIENT_SECRET (or MEDALLIA_API_TOKEN)."
    );
  }
}

async function startStdioServer() {
  const transport = new CompatibleStdioTransport();
  serveStdio(createMedalliaMcpServer, { legacy: "serve", transport });
  console.error("[Medallia MCP Server] Started successfully over stdio transport");
  logCredentialWarning();

  setInterval(() => {
    // Keep the stdio process alive while the MCP client is connected.
  }, 60_000);

  await new Promise<void>(() => {});
}

function writeJsonErrorResponse(
  statusCode: number,
  message: string,
  response: import("node:http").ServerResponse
) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: message }));
}

async function startHttpServer() {
  const handler = toNodeHandler(createMcpHandler(createMedalliaMcpServer), {
    onerror: (error) => {
      console.error(`[Medallia MCP Server] HTTP handler error: ${error.message}`);
    },
  });

  const validateHost =
    MCP_ALLOWED_HOSTS.length > 0
      ? hostHeaderValidation(MCP_ALLOWED_HOSTS)
      : isLoopbackHost(MCP_HTTP_HOST)
        ? localhostHostValidation()
        : undefined;
  const validateOrigin =
    MCP_ALLOWED_ORIGINS.length > 0
      ? originValidation(MCP_ALLOWED_ORIGINS)
      : isLoopbackHost(MCP_HTTP_HOST)
        ? localhostOriginValidation()
        : undefined;

  const httpServer = createServer(async (request, response) => {
    try {
      if (validateHost && !validateHost(request, response)) {
        return;
      }
      if (validateOrigin && !validateOrigin(request, response)) {
        return;
      }

      const requestUrl = new URL(
        request.url || "/",
        `http://${request.headers.host || "localhost"}`
      );
      if (requestUrl.pathname !== MCP_HTTP_PATH) {
        writeJsonErrorResponse(404, "Not Found", response);
        return;
      }

      await handler(request, response);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      writeJsonErrorResponse(500, `Internal Server Error: ${message}`, response);
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(MCP_HTTP_PORT, MCP_HTTP_HOST, () => {
      resolve();
    });
  });

  console.error(
    `[Medallia MCP Server] Started successfully over HTTP transport at http://${MCP_HTTP_HOST}:${MCP_HTTP_PORT}${MCP_HTTP_PATH}`
  );
  if (
    !isLoopbackHost(MCP_HTTP_HOST) &&
    MCP_ALLOWED_HOSTS.length === 0 &&
    MCP_ALLOWED_ORIGINS.length === 0
  ) {
    console.error(
      "[Medallia MCP Server] WARNING: Host/Origin validation is disabled for a non-loopback host. Set MCP_ALLOWED_HOSTS and MCP_ALLOWED_ORIGINS."
    );
  }
  logCredentialWarning();
}

async function main() {
  if (MCP_TRANSPORT === "stdio") {
    await startStdioServer();
    return;
  }
  if (MCP_TRANSPORT === "http") {
    await startHttpServer();
    return;
  }

  throw new Error(
    `Unsupported MCP_TRANSPORT value: ${MCP_TRANSPORT}. Use "stdio" or "http".`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
