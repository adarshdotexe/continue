import Parser from "web-tree-sitter";
import type {
  ChunkWithoutID,
  ContextItem,
  ContextSubmenuItem,
  IDE,
  IndexTag,
  IndexingProgressUpdate,
} from "../";
import { getBasename, getLastNPathParts } from "../util/";
import { migrate } from "../util/paths";
import {
  TSQueryType,
  getParserForFile,
  getQueryForFile,
} from "../util/treeSitter";
import { DatabaseConnection, SqliteDb, tagToString } from "./refreshIndex";
import {
  IndexResultType,
  MarkCompleteCallback,
  RefreshIndexResults,
  type CodebaseIndex,
} from "./types";

type SnippetChunk = ChunkWithoutID & { title: string; signature: string };

export class CodeSnippetsCodebaseIndex implements CodebaseIndex {
  relativeExpectedTime: number = 1;
  artifactId = "codeSnippets";

  constructor(private readonly ide: IDE) {}

  private static async _createTables(db: DatabaseConnection) {
    await db.exec(`CREATE TABLE IF NOT EXISTS code_snippets (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        cacheKey TEXT NOT NULL,
        content TEXT NOT NULL,
        title TEXT NOT NULL,
        signature TEXT NOT NULL,
        startLine INTEGER NOT NULL,
        endLine INTEGER NOT NULL
    )`);

    await db.exec(`CREATE TABLE IF NOT EXISTS code_snippets_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT NOT NULL,
      snippetId INTEGER NOT NULL,
      FOREIGN KEY (snippetId) REFERENCES code_snippets (id)
    )`);

    migrate("add_signature_column", async () => {
      await db.exec(`
        ALTER TABLE code_snippets
        ADD COLUMN signature TEXT;
      `);
    });

    migrate("delete_duplicate_code_snippets", async () => {
      // Delete duplicate entries in code_snippets
      await db.exec(`
        DELETE FROM code_snippets
        WHERE id NOT IN (
          SELECT MIN(id)
          FROM code_snippets
          GROUP BY path, cacheKey, content, title, startLine, endLine
        )
      `);

      // Add unique constraint if it doesn't exist
      await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_code_snippets_unique
        ON code_snippets (path, cacheKey, content, title, startLine, endLine)
      `);

      // Delete code_snippets associated with duplicate code_snippets_tags entries
      await db.exec(`
        DELETE FROM code_snippets
        WHERE id IN (
          SELECT snippetId
          FROM code_snippets_tags
          WHERE (snippetId, tag) IN (
            SELECT snippetId, tag
            FROM code_snippets_tags
            GROUP BY snippetId, tag
            HAVING COUNT(*) > 1
          )
        )
      `);

      // Delete duplicate entries
      await db.exec(`
        DELETE FROM code_snippets_tags
        WHERE id NOT IN (
          SELECT MIN(id)
          FROM code_snippets_tags
          GROUP BY snippetId, tag
        )
      `);

      // Add unique constraint if it doesn't exist
      await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_snippetId_tag
        ON code_snippets_tags (snippetId, tag)
      `);
    });
  }

  private getSnippetsFromMatch(match: Parser.QueryMatch): SnippetChunk {
    let title = "",
      content = "",
      signature = "",
      parameters = "",
      returnType = "",
      startLine = 0,
      endLine = 0;

    const nodeTypesToTreatAsSignatures = ["interface_declaration"];

    for (const { name, node } of match.captures) {
      const nodeText = node.text;
      const nodeType = node.type;

      switch (name) {
        case "name":
          title = nodeText;
          break;
        case "body":
          if (nodeTypesToTreatAsSignatures.includes(nodeType)) {
            signature = nodeText;
          }

          content = nodeText;
          startLine = node.startPosition.row;
          endLine = node.endPosition.row;

          break;
        case "parameters":
          parameters = nodeText;
          break;
        case "return_type":
          returnType = nodeText;
          break;
      }
    }

    if (signature === "") {
      signature = `${title}${parameters}${returnType}`;
    }

    return { title, content, signature, startLine, endLine };
  }

  async getSnippetsInFile(
    filepath: string,
    contents: string,
  ): Promise<SnippetChunk[]> {
    const parser = await getParserForFile(filepath);

    if (!parser) {
      return [];
    }

    const ast = parser.parse(contents);
    const query = await getQueryForFile(filepath, TSQueryType.CodeSnippets);
    const matches = query?.matches(ast.rootNode);

    if (!matches) {
      return [];
    }

    return matches.map(this.getSnippetsFromMatch);
  }

  async *update(
    tag: IndexTag,
    results: RefreshIndexResults,
    markComplete: MarkCompleteCallback,
    repoName: string | undefined,
  ): AsyncGenerator<IndexingProgressUpdate, any, unknown> {
    const db = await SqliteDb.get();
    await CodeSnippetsCodebaseIndex._createTables(db);
    const tagString = tagToString(tag);

    // Compute
    for (let i = 0; i < results.compute.length; i++) {
      const compute = results.compute[i];

      let snippets: SnippetChunk[] = [];
      try {
        snippets = await this.getSnippetsInFile(
          compute.path,
          await this.ide.readFile(compute.path),
        );
      } catch (e) {
        // If can't parse, assume malformatted code
        console.error(`Error parsing ${compute.path}:`, e);
      }

      // Add snippets to sqlite
      for (const snippet of snippets) {
        const { lastID } = await db.run(
          "REPLACE INTO code_snippets (path, cacheKey, content, title, signature, startLine, endLine) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            compute.path,
            compute.cacheKey,
            snippet.content,
            snippet.title,
            snippet.signature,
            snippet.startLine,
            snippet.endLine,
          ],
        );

        await db.run(
          "REPLACE INTO code_snippets_tags (snippetId, tag) VALUES (?, ?)",
          [lastID, tagString],
        );
      }

      yield {
        desc: `Indexing ${getBasename(compute.path)}`,
        progress: i / results.compute.length,
        status: "indexing",
      };
      markComplete([compute], IndexResultType.Compute);
    }

    // Delete
    for (let i = 0; i < results.del.length; i++) {
      const del = results.del[i];

      const snippets = await db.all(
        "SELECT id FROM code_snippets WHERE path = ? AND cacheKey = ?",
        [del.path, del.cacheKey],
      );

      if (snippets) {
        const snippetIds = snippets.map((row) => row.id).join(",");

        await db.run(`DELETE FROM code_snippets WHERE id IN (${snippetIds})`);

        await db.run(
          `DELETE FROM code_snippets_tags WHERE snippetId IN (${snippetIds})`,
        );
      }

      markComplete([del], IndexResultType.Delete);
    }

    // Add tag
    for (let i = 0; i < results.addTag.length; i++) {
      const addTag = results.addTag[i];
      let snippets: SnippetChunk[] = [];
      try {
        snippets = await this.getSnippetsInFile(
          addTag.path,
          await this.ide.readFile(addTag.path),
        );
      } catch (e) {
        // If can't parse, assume malformatted code
        console.error(`Error parsing ${addTag.path}:`, e);
      }

      for (const snippet of snippets) {
        const { lastID } = await db.run(
          "REPLACE INTO code_snippets (path, cacheKey, content, title, signature, startLine, endLine) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            addTag.path,
            addTag.cacheKey,
            snippet.content,
            snippet.title,
            snippet.signature,
            snippet.startLine,
            snippet.endLine,
          ],
        );
        await db.run(
          "REPLACE INTO code_snippets_tags (snippetId, tag) VALUES (?, ?)",
          [lastID, tagString],
        );
      }

      markComplete([results.addTag[i]], IndexResultType.AddTag);
    }

    // Remove tag
    for (let i = 0; i < results.removeTag.length; i++) {
      const removeTag = results.removeTag[i];

      const snippet = await db.get(
        `SELECT id FROM code_snippets
            WHERE cacheKey = ? AND path = ?`,
        [removeTag.cacheKey, removeTag.path],
      );
      if (!Array.isArray(snippets)) {
        snippets = [snippets];
      }

      if (snippet) {
        await db.run(
          `
          DELETE FROM code_snippets_tags
          WHERE tag = ?
            AND snippetId = ?
        `,
          [tagString, snippet.id],
        );
      }

      markComplete([results.removeTag[i]], IndexResultType.RemoveTag);
    }
  }

  static async getForId(id: number): Promise<ContextItem> {
    const db = await SqliteDb.get();
    const row = await db.get("SELECT * FROM code_snippets WHERE id = ?", [id]);

    return {
      name: row.title,
      description: getLastNPathParts(row.path, 2),
      content: `\`\`\`${getBasename(row.path)}\n${row.content}\n\`\`\``,
    };
  }

  static async getAll(tag: IndexTag): Promise<ContextSubmenuItem[]> {
    const db = await SqliteDb.get();
    await CodeSnippetsCodebaseIndex._createTables(db);
    try {
      const rows = await db.all(
        `SELECT cs.id, cs.path, cs.title
        FROM code_snippets cs
        JOIN code_snippets_tags cst ON cs.id = cst.snippetId
        WHERE cst.tag = ?;
        `,
        [tagToString(tag)],
      );

      return rows.map((row) => ({
        title: row.title,
        description: getLastNPathParts(row.path, 2),
        id: row.id.toString(),
      }));
    } catch (e) {
      console.warn("Error getting all code snippets: ", e);
      return [];
    }
  }

  static async getAllPathsAndSignatures(batchSize: number = 1000): AsyncGenerator<{ path: string; signatures: string[] }> {
    const db = await SqliteDb.get();
    await CodeSnippetsCodebaseIndex._createTables(db);

    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const rows = await db.all(
        `SELECT path, signature
         FROM code_snippets
         ORDER BY path
         LIMIT ? OFFSET ?`,
        [batchSize, offset]
      );

      if (rows.length === 0) {
        hasMore = false;
        continue;
      }

      const groupedByPath: { [path: string]: string[] } = {};
      for (const row of rows) {
        if (!groupedByPath[row.path]) {
          groupedByPath[row.path] = [];
        }
        groupedByPath[row.path].push(row.signature);
      }

      for (const [path, signatures] of Object.entries(groupedByPath)) {
        yield { path, signatures };
      }

      offset += batchSize;
    }
  }
}
