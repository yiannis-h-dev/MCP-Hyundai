#!/usr/bin/env node

/**
 * Test client for Medallia MCP Server
 * Tests connection status and demonstrates API tool usage
 */

import { spawn } from "child_process";

// Spawn the server process
const serverProcess = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_TLS_REJECT_UNAUTHORIZED:
      process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0",
  },
});

let messageId = 1;
const pendingMessages = new Map();

// Handle server stdout
serverProcess.stdout.on("data", (data) => {
  const messages = data.toString().split("\n").filter((line) => line.trim());

  for (const message of messages) {
    try {
      const response = JSON.parse(message);

      // Match response to request by ID
      if (response.id && pendingMessages.has(response.id)) {
        const pending = pendingMessages.get(response.id);
        clearTimeout(pending.timeout);
        pending.resolve(response);
        pendingMessages.delete(response.id);
      }
    } catch (e) {
      // Ignore non-JSON lines (like debug output)
    }
  }
});

// Handle server errors
serverProcess.stderr.on("data", (data) => {
  console.error("[Server]", data.toString().trim());
});

// Send a message to the server and wait for response
function sendMessage(method, params) {
  return new Promise((resolve, reject) => {
    const id = messageId++;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const timeout = setTimeout(() => {
      pendingMessages.delete(id);
      reject(new Error(`Timeout waiting for message ${id}`));
    }, 5000);

    pendingMessages.set(id, { resolve, reject, timeout });
    serverProcess.stdin.write(JSON.stringify(message) + "\n");
  });
}

// Run tests
async function runTests() {
  console.log("🚀 Starting Medallia MCP Server tests...\n");
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
    console.log(
      "⚠️  TLS certificate verification is disabled for this test run (NODE_TLS_REJECT_UNAUTHORIZED=0).\n"
    );
  }

  try {
    // Test 1: Check connection status
    console.log("📊 Test 1: Checking Medallia API connection status...");
    const statusResponse = await sendMessage("resources/read", {
      uri: "medallia://connection-status",
    });

    if (statusResponse.result?.contents?.[0]?.text) {
      const status = JSON.parse(statusResponse.result.contents[0].text);
      console.log(
        "✅ Status:",
        status.authenticated ? "Authenticated" : "Not authenticated"
      );
      console.log("   Endpoint:", status.endpoint);
      console.log("   Status:", status.status);
      console.log();
    }

    // Test 2: List programs (this will fail without credentials, but demonstrates the tool)
    console.log(
      "📋 Test 2: Listing Experience Programs (requires OAuth credentials)..."
    );
    const programsResponse = await sendMessage("tools/call", {
      name: "getPrograms",
      arguments: { limit: 3 },
    });

    if (programsResponse.result?.content?.[0]?.text) {
      const text = programsResponse.result.content[0].text;
      console.log("✅ Response:", text.substring(0, 200) + "...\n");
    } else if (programsResponse.error) {
      console.log(
        "⚠️  Error (expected without credentials):",
        programsResponse.error.message
      );
      console.log();
    }

    // Test 3: Query feedback (will fail without credentials)
    console.log(
      "📈 Test 3: Querying feedback records (requires OAuth credentials)..."
    );
    const feedbackResponse = await sendMessage("tools/call", {
      name: "queryFeedback",
      arguments: { limit: 5 },
    });

    if (feedbackResponse.result?.content?.[0]?.text) {
      const text = feedbackResponse.result.content[0].text;
      console.log("✅ Response:", text.substring(0, 200) + "...\n");
    } else if (feedbackResponse.error) {
      console.log(
        "⚠️  Error (expected without credentials):",
        feedbackResponse.error.message
      );
      console.log();
    }

    // Test 4: Query customers (will fail without credentials)
    console.log(
      "👥 Test 4: Querying customer profiles (requires OAuth credentials)..."
    );
    const customersResponse = await sendMessage("tools/call", {
      name: "queryCustomers",
      arguments: { limit: 5 },
    });

    if (customersResponse.result?.content?.[0]?.text) {
      const text = customersResponse.result.content[0].text;
      console.log("✅ Response:", text.substring(0, 200) + "...\n");
    } else if (customersResponse.error) {
      console.log(
        "⚠️  Error (expected without credentials):",
        customersResponse.error.message
      );
      console.log();
    }

    // Test 5: Get aggregate metrics (will fail without credentials)
    console.log(
      "📊 Test 5: Calculating aggregate metrics (requires OAuth credentials)..."
    );
    const aggregateResponse = await sendMessage("tools/call", {
      name: "getAggregates",
      arguments: { metric: "average", fieldId: "e_ltr" },
    });

    if (aggregateResponse.result?.content?.[0]?.text) {
      const text = aggregateResponse.result.content[0].text;
      console.log("✅ Response:", text.substring(0, 200) + "...\n");
    } else if (aggregateResponse.error) {
      console.log(
        "⚠️  Error (expected without credentials):",
        aggregateResponse.error.message
      );
      console.log();
    }

    console.log("✅ All tests completed!");
    console.log("\n📝 To use Medallia tools:");
    console.log(
      "   1. Set MEDALLIA_CLIENT_ID and MEDALLIA_CLIENT_SECRET"
    );
    console.log(
      "   2. Set MEDALLIA_REPORTING_INSTANCE and MEDALLIA_TENANT_NAME (or MEDALLIA_OAUTH_TOKEN_URL)"
    );
    console.log(
      "   3. Optionally set MEDALLIA_API_ENDPOINT (defaults to https://api.medallia.com/v2/graphql)"
    );
    console.log("   4. Restart the MCP server\n");
  } catch (error) {
    console.error("❌ Test failed:", error.message);
  }

  // Close the server
  serverProcess.kill();
  process.exit(0);
}

// Start tests after a brief delay
setTimeout(runTests, 500);

// Timeout if tests take too long
setTimeout(() => {
  console.error("❌ Tests timed out");
  serverProcess.kill();
  process.exit(1);
}, 15000);
