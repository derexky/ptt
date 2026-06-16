const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function main() {
  console.log("Starting MCP Client...");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["mcp-server.js"],
  });

  const client = new Client(
    {
      name: "mcp-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  try {
    console.log("Connecting to server...");
    await client.connect(transport);
    console.log("Connected!");

    console.log("Listing tools...");
    const result = await client.listTools();
    
    console.log("\nDatebase of Tools:");
    result.tools.forEach(tool => {
        console.log(`- ${tool.name}: ${tool.description}`);
    });
    
    console.log("\nSuccess! The MCP server is responding correctly.");

  } catch (error) {
    console.error("Error:", error);
  } finally {
    // We don't close the transport explicitly here to let the script exit naturally or via Ctrl+C if needed,
    // but for a test script, closing is good.
    try {
        await client.close(); 
    } catch(e) {}
  }
}

main();
