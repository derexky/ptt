const fs = require('fs');
const path = require('path');

// Override console.log to write to stderr to avoid interfering with JSON-RPC on stdout
// Also write to a log file for debugging
const LOG_FILE = path.join(__dirname, 'server.log');

function logToFile(...args) {
  try {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
  } catch (e) {
    // Ignore logging errors
  }
}

const originalConsoleError = console.error;
console.error = function(...args) {
  logToFile(...args);
  originalConsoleError.apply(console, args);
};
console.log = console.error;

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const z = require("zod");
const { crawlNewPosts, crawlAllPosts } = require("./crawl");
const { Poster } = require("./poster");
const { generateContentByGoogle } = require("./ai");

// Create an MCP server
const server = new McpServer({
  name: "ptt-tools",
  version: "1.0.0"
});

// Tool: Crawl New Posts
// Tool: Crawl New Posts
server.registerTool(
  "crawl_new_posts",
  {
    description: "Crawl the latest N pages of a PTT board.",
    inputSchema: {
      boardName: z.string().describe("The name of the PTT board (e.g., Gossiping, C_Chat)."),
      pages: z.number().optional().default(10).describe("Number of latest pages to crawl. Default is 10.")
    }
  },
  async ({ boardName, pages }) => {
    try {
      console.error(`[MCP] Starting crawl for ${boardName}, ${pages} pages...`); // Log to stderr to avoid interfering with stdout JSON-RPC
      await crawlNewPosts(pages, boardName);
      return {
        content: [{ type: "text", text: `Successfully crawled ${pages} pages from ${boardName}. Check database for results.` }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error crawling posts: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Crawl All Posts (Range)
// Tool: Crawl All Posts (Range)
server.registerTool(
  "crawl_all_posts",
  {
    description: "Crawl all posts from a PTT board (based on config range or defaults).",
    inputSchema: {
      boardName: z.string().describe("The name of the PTT board.")
    }
  },
  async ({ boardName }) => {
    try {
      console.error(`[MCP] Starting full crawl for ${boardName}...`);
      await crawlAllPosts(boardName);
      return {
        content: [{ type: "text", text: `Successfully crawled posts from ${boardName}. Check database for results.` }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error crawling posts: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Post Article
// Tool: Post Article
server.registerTool(
  "post_article",
  {
    description: "Post an article to PTT.",
    inputSchema: {
      id: z.string().default(process.env.PTT_ID).describe("PTT User ID"),
      password: z.string().default(process.env.PTT_PASSWORD).describe("PTT Password"),
      board: z.string().describe("Board name"),
      title: z.string().optional().describe("Article title"),
      content: z.string().optional().describe("Article content"),
      category: z.number().optional().default(1).describe("Category index (default 1)"),
      target: z.string().optional().describe("Target subject to discuss"),
      stance: z.string().optional().describe("Stance/persona for the AI"),
      aid: z.string().optional().describe("Article ID (AID) to reply to. If omitted, a new post will be created.")
    }
  },
  async ({ id, password, board, title, content, category, aid }) => {
    try {
      const poster = new Poster(id, password);
      const _ = poster.postArticle({
        board,
        title,
        draft: content, // Use draft as content
        category,
        aid, // Pass aid to Poster
        isSendByWord: true // Default to true for safety
      })
      const result = await poster.contentReady
      poster.continueState()
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
       return {
        content: [{ type: "text", text: `Error posting article: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Generate AI Content
// Tool: Generate AI Content
server.registerTool(
  "generate_ai_content",
  {
    description: "Generate content using Google Gemini AI.",
    inputSchema: {
      prompt: z.string().describe("The prompt for the AI."),
      stance: z.string().optional().describe("The stance/persona for the AI."),
      target: z.string().optional().describe("The target subject to discuss."),
      isTroll: z.boolean().optional().default(true).describe("Whether to use a troll tone.")
    }
  },
  async ({ prompt, stance, target, isTroll }) => {
    try {
      const result = await generateContentByGoogle({ prompt, stance, target, isTroll });
      if (result.success) {
        return {
          content: [{ type: "text", text: result.value }]
        };
      } else {
        return {
          content: [{ type: "text", text: `AI Generation Failed: ${result.message}` }],
          isError: true
        };
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error generating content: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("PTT MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
