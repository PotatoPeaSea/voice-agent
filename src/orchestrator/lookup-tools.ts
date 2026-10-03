import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { WRITE_MODES, type Workspace, type WriteMode } from "../lookup/files.js";
import type { ToolContext } from "./tools.js";
import { errorMessage, parseArgs, toolName, type ToolSet } from "./toolset.js";

const pathProp = {
  type: "string",
  description:
    'A folder name from list_files (a project like "Voice Agent", or one in the home folder like "Documents"), a path inside one ("Voice Agent/src/main.ts"), or an absolute path inside an allowed root.',
} as const;

export const LOOKUP_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List a folder on the user's computer, or find files below it by name. Omit path to list the allowed roots (project folders and the home folder) and what's in them.",
      parameters: {
        type: "object",
        properties: {
          path: pathProp,
          name: { type: "string", description: 'Find files below the folder whose name contains this, or a glob like "*.ts". Omit to just list the folder.' },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file on the user's computer (about 4000 characters at a time; use from_line for more).",
      parameters: {
        type: "object",
        properties: { path: pathProp, from_line: { type: "number", description: "Line to start at (default 1)." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search the text of files below a folder for a word or regex (case-insensitive). Returns matching lines with file and line number.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text or regex to look for." },
          path: pathProp,
          files: { type: "string", description: 'Only search files whose name matches this glob, e.g. "*.ts".' },
        },
        required: ["pattern", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_info",
      description: "A project's git branch, uncommitted changes and last 8 commits.",
      parameters: { type: "object", properties: { path: pathProp }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "current_time",
      description: "The current date, time and time zone on the user's computer.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const NAMES = new Set(LOOKUP_TOOL_DEFINITIONS.map(toolName));

/** Read-only lookups the front model runs itself, instead of dispatching an agent. */
export class LookupTools implements ToolSet {
  readonly definitions = LOOKUP_TOOL_DEFINITIONS;

  constructor(private readonly workspace: Workspace) {}

  handles(name: string): boolean {
    return NAMES.has(name);
  }

  async execute(name: string, rawArgs: string, ctx: ToolContext): Promise<unknown> {
    const args = parseArgs(rawArgs);
    if (typeof args === "string") return { error: args };
    const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
    const ws = this.workspace;
    try {
      switch (name) {
        case "list_files": {
          const path = str("path");
          return path?.trim() ? await ws.list(path, str("name"), ctx.signal) : await ws.projects();
        }
        case "read_file":
          return await ws.read(str("path") ?? "", Number(args.from_line) || 1);
        case "search_files":
          return await ws.search(str("pattern") ?? "", str("path") ?? "", str("files"), ctx.signal);
        case "git_info":
          return await ws.git(str("path") ?? "", ctx.signal);
        case "current_time": {
          const now = new Date();
          return {
            now: now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" }),
            time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            iso: now.toISOString(),
          };
        }
        default:
          return { error: `unknown tool ${name}` };
      }
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }
}

export const FOLDER_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_folder",
      description:
        "Create a new folder (and any missing parent folders) on the user's computer, inside the allowed roots. " +
        "Does nothing if it already exists. Say where you made it in your reply.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Where to make it: an existing folder plus the new name, e.g. "Documents/Recipes", "Voice Agent/notes/ideas", or an absolute path.',
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Add to or create a text file on the user's computer, inside the allowed roots, e.g. an item on a to-do list or a note. " +
        'Mode "append" (default) adds the text as new lines at the end of an existing file; "create" makes a new file; ' +
        '"replace" swaps the whole file\'s text, so read_file it first and confirm with the user. Can\'t delete files.',
      parameters: {
        type: "object",
        properties: {
          path: { ...pathProp, description: `${pathProp.description} For "create", an existing folder plus the new file name.` },
          text: { type: "string", description: "The text to write, plain text with line breaks as needed." },
          mode: { type: "string", enum: [...WRITE_MODES], description: 'append (default), create or replace.' },
        },
        required: ["path", "text"],
      },
    },
  },
];

/** File tools that change things (kept apart from LookupTools, which the read-only quick agent also gets). */
export class FolderTools implements ToolSet {
  readonly definitions: ChatCompletionTool[];
  private readonly names: Set<string>;

  /** write: offer write_file too (FILE_WRITE_ENABLED). */
  constructor(private readonly workspace: Workspace, { write = true }: { write?: boolean } = {}) {
    this.definitions = FOLDER_TOOL_DEFINITIONS.filter((d) => write || toolName(d) !== "write_file");
    this.names = new Set(this.definitions.map(toolName));
  }

  handles(name: string): boolean {
    return this.names.has(name);
  }

  async execute(name: string, rawArgs: string): Promise<unknown> {
    const args = parseArgs(rawArgs);
    if (typeof args === "string") return { error: args };
    if (!this.handles(name)) return { error: `unknown tool ${name}` };
    const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
    try {
      switch (name) {
        case "create_folder":
          return await this.workspace.createFolder(str("path"));
        case "write_file":
          return await this.workspace.writeFile(str("path"), str("text"), (str("mode").trim().toLowerCase() || "append") as WriteMode);
        default:
          return { error: `unknown tool ${name}` };
      }
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }
}
