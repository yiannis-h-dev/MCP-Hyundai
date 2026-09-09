import { spawn } from "child_process";
import { createInterface } from "readline";

// Start the server
const server = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
});

// Setup stdio communication
const rl = createInterface({
  input: server.stdout,
  output: server.stdin,
  terminal: false,
});

let messageId = 1;

async function sendMessage(method, params) {
  return new Promise((resolve) => {
    const id = messageId++;
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    console.log(`📤 Sending: ${method}`, JSON.stringify(params, null, 2));
    server.stdin.write(message + "\n");

    // Listen for response
    const handleLine = (line) => {
      try {
        const response = JSON.parse(line);
        if (response.id === id) {
          console.log(`📥 Response:`, JSON.stringify(response.result || response.error, null, 2));
          rl.removeListener("line", handleLine);
          resolve(response);
        }
      } catch (e) {
        // Ignore parsing errors
      }
    };

    rl.on("line", handleLine);
    setTimeout(() => rl.removeListener("line", handleLine), 5000);
  });
}

async function runTests() {
  console.log("🧪 Testing MCP Server\n");

  // Test 1: Call the greet tool
  await sendMessage("tools/call", {
    name: "greet",
    arguments: { name: "Alice" },
  });

  // Test 2: Call the add tool
  await sendMessage("tools/call", {
    name: "add",
    arguments: { a: 5, b: 3 },
  });

  // Test 3: Get server info resource
  await sendMessage("resources/read", {
    uri: "info://server-status",
  });

  server.kill();
  process.exit(0);
}

runTests().catch(console.error);
