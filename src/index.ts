import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool as MCPTool,
} from "@modelcontextprotocol/sdk/types.js";
import SwaggerParser from "@apidevtools/swagger-parser";
import { ScoutAPI } from "./scout";
import { MCPResource, ResourceConfig } from "./types";
import { API } from "./api";

interface Parameter {
  $ref?: string;
  name?: string;
  in?: "path" | "query" | "header" | "cookie";
  required?: boolean;
  schema?: any;
  description?: string;
}

interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<Parameter>;
  requestBody?: {
    required?: boolean;
    content?: {
      "application/json"?: {
        schema?: any;
      };
    };
  };
  responses?: any;
}

interface ToolInfo {
  scoutEndpoint?: string;
  config: ResourceConfig;
  path?: string;
  method?: string;
  operation?: OpenAPIOperation;
}

type Tool = MCPTool & ToolInfo;

const PAT_TOKEN = process.env.PAT_TOKEN;

class HubMCPServer {
  private server: Server;
  private resources: Map<string, MCPResource> = new Map();

  constructor() {
    this.server = new Server(
      {
        name: "dockerhub-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
    this.setupHandlers();
  }

  async loadResources(config: ResourceConfig): Promise<void> {
    try {
      console.error(`Loading resource definition of ${config.name}...`);
      if (config.name === "scout") {
        const resource = new ScoutAPI(config);
        resource.RegisterTools();
        this.resources.set(config.name, resource);
        console.error(
          `✅ Loaded ${config.name} with ${resource.GetToolsCount()} operations`
        );
        return;
      }
      let spec: any;
      if (config.specPath && config.specPath.startsWith("https:")) {
        spec = await SwaggerParser.parse(config.specPath);
      } else if (config.specPath && config.specPath.startsWith("file:")) {
        spec = config.specPath.replace("file://", "");
      }
      // Parse and dereference the OpenAPI spec
      spec = await SwaggerParser.dereference(spec);
      const resource = new API(spec, config);
      resource.RegisterTools();
      this.resources.set(config.name, resource);
      console.error(
        `✅ Loaded ${config.name} with ${resource.GetToolsCount()} operations`
      );
    } catch (error) {
      console.error(`❌ Failed to load resource ${config.name}:`, error);
      throw error;
    }
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: MCPTool[] = [];

      this.resources.forEach((resource) => {
        tools.push(...resource.GetTools());
      });
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      console.error(`Calling tool: ${name}`);
      for (const resource of this.resources.values()) {
        const tool = resource.GetTool(name);
        if (tool) {
          return await resource.ExecuteTool(name, args);
        }
      }
      throw new Error(`Tool ${name} not found`);
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("🚀 OpenAPI MCP Server is running...");
  }
}

// Configuration - you can load this from a JSON file
const configs: ResourceConfig[] = [
  {
    name: "repos",
    specPath:
      process.env.OPENAPI_SPEC_REPOS && process.env.OPENAPI_SPEC_REPOS !== ""
        ? process.env.OPENAPI_SPEC_REPOS
        : "file://./specs/repos.json",
    host: "https://hub.docker.com",
    auth: {
      type: "pat",
      token: process.env.HUB_PAT_TOKEN,
      username: process.env.HUB_USERNAME,
    },
  },
  {
    name: "search",
    specPath:
      process.env.OPENAPI_SPEC_SEARCH && process.env.OPENAPI_SPEC_SEARCH !== ""
        ? process.env.OPENAPI_SPEC_SEARCH
        : "file://./specs/search.yaml",
    host: "https://hub.docker.com/api/search",
  },
  {
    name: "scout",
    host: "https://api.scout.docker.com",
    auth: {
      type: "bearer",
      token: process.env.SCOUT_TOKEN,
    },
  },
];

// Main execution
async function main() {
  const server = new HubMCPServer();

  // Load all configured APIs
  for (const config of configs) {
    try {
      await server.loadResources(config);
    } catch (error) {
      console.error(`Failed to load API ${config.name}, skipping...`);
    }
  }

  // Start the server
  await server.run();
}

// Handle errors and start the server
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
  process.exit(1);
});

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

