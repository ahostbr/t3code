import { Effect, FileSystem, Path } from "effect";

import { expandHomePath } from "./os-jank.ts";

export interface ClaudeSlashEntry {
  readonly kind: "command" | "skill";
  readonly name: string;
  readonly prompt: string;
  readonly path: string;
  readonly description?: string;
}

function normalizePathSegment(value: string): string {
  return value.replaceAll("\\", "/");
}

function stemFromPath(pathValue: string): string {
  const normalized = normalizePathSegment(pathValue);
  const lastDotIndex = normalized.lastIndexOf(".");
  if (lastDotIndex <= normalized.lastIndexOf("/")) {
    return normalized;
  }
  return normalized.slice(0, lastDotIndex);
}

function trimDescription(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function descriptionFromMarkdown(markdown: string): string | undefined {
  const frontmatterMatch = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const frontmatter = frontmatterMatch?.[1];
  const frontmatterDescription = trimDescription(
    /^description:\s*(.+)$/m.exec(frontmatter ?? "")?.[1],
  );
  if (frontmatterDescription) {
    return frontmatterDescription;
  }

  const firstMeaningfulLine = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => {
      if (line.length === 0) return false;
      if (line === "---") return false;
      if (line.startsWith("#")) return false;
      if (line.startsWith("name:")) return false;
      if (line.startsWith("description:")) return false;
      return true;
    });
  return trimDescription(firstMeaningfulLine);
}

const collectFilesRecursively = (
  rootDir: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const visit = (
      currentDir: string,
    ): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function* () {
        const entries = yield* fileSystem
          .readDirectory(currentDir, { recursive: false })
          .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

        const nested = yield* Effect.forEach(
          entries,
          (entryName) =>
            Effect.gen(function* () {
              const absolutePath = path.join(currentDir, entryName);
              const stat = yield* fileSystem
                .stat(absolutePath)
                .pipe(Effect.catch(() => Effect.succeed(null)));
              if (!stat) {
                return [] as Array<string>;
              }
              if (stat.type === "Directory") {
                return Array.from(yield* visit(absolutePath));
              }
              return stat.type === "File" ? [absolutePath] : [];
            }),
          { concurrency: 1 },
        );

        return nested.flat();
      });

    return yield* visit(rootDir);
  });

export const readClaudeSlashEntries = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const claudeHome = yield* expandHomePath("~/.claude");
  const commandsRoot = path.join(claudeHome, "commands");
  const skillsRoot = path.join(claudeHome, "skills");

  const commandFiles = yield* collectFilesRecursively(commandsRoot);
  const commandEntries = yield* Effect.forEach(
    commandFiles,
    (absolutePath) =>
      Effect.gen(function* () {
        const relativePath = normalizePathSegment(path.relative(commandsRoot, absolutePath));
        if (!relativePath || relativePath.startsWith("..")) {
          return null;
        }
        const name = stemFromPath(relativePath);
        if (!name) {
          return null;
        }
        const raw = yield* fileSystem
          .readFileString(absolutePath)
          .pipe(Effect.catch(() => Effect.succeed("")));
        const description = descriptionFromMarkdown(raw);
        return {
          kind: "command" as const,
          name,
          prompt: `/${name}`,
          path: absolutePath,
          ...(description ? { description } : {}),
        } satisfies ClaudeSlashEntry;
      }),
    { concurrency: 4 },
  );

  const skillDirectories = yield* fileSystem
    .readDirectory(skillsRoot, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
  const skillEntries = yield* Effect.forEach(
    skillDirectories,
    (entryName) =>
      Effect.gen(function* () {
        const skillDir = path.join(skillsRoot, entryName);
        const stat = yield* fileSystem.stat(skillDir).pipe(Effect.catch(() => Effect.succeed(null)));
        if (!stat || stat.type !== "Directory") {
          return null;
        }
        const skillMarkdownPath = path.join(skillDir, "SKILL.md");
        const skillMarkdown = yield* fileSystem
          .readFileString(skillMarkdownPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!skillMarkdown) {
          return null;
        }
        const name = normalizePathSegment(entryName).trim();
        if (!name) {
          return null;
        }
        const description = descriptionFromMarkdown(skillMarkdown);
        return {
          kind: "skill" as const,
          name,
          prompt: `/${name}`,
          path: skillMarkdownPath,
          ...(description ? { description } : {}),
        } satisfies ClaudeSlashEntry;
      }),
    { concurrency: 4 },
  );

  return [...commandEntries, ...skillEntries]
    .filter((entry): entry is ClaudeSlashEntry => entry !== null)
    .toSorted((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "command" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
});
