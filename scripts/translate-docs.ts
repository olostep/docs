#!/usr/bin/env npx ts-node
/**
 * Translates MDX documentation files to multiple languages using OpenAI.
 *
 * Usage:
 *   npx ts-node translate-docs.ts --phase=catchup
 *   npx ts-node translate-docs.ts --phase=incremental --files=a.mdx,b.mdx
 *
 * @module translate-docs
 */

import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";

interface LanguageInfo {
  name: string;
  nativeName: string;
}

interface TranslationError {
  file: string;
  lang: string;
  error: string;
}

interface TranslationResult {
  totalTranslations: number;
  errors: TranslationError[];
}

const LANGUAGES: Record<string, LanguageInfo> = {
  de: { name: "German", nativeName: "Deutsch" },
  fr: { name: "French", nativeName: "Français" },
  es: { name: "Spanish", nativeName: "Español" },
  nl: { name: "Dutch", nativeName: "Nederlands" },
  zh: { name: "Chinese (Simplified)", nativeName: "简体中文" },
  it: { name: "Italian", nativeName: "Italiano" },
  ja: { name: "Japanese", nativeName: "日本語" },
};

const DOCS_ROOT = path.resolve(__dirname, "..");
const DOCS_CONFIG_PATH = path.join(DOCS_ROOT, "docs.json");

const SKIP_DIRS = ["node_modules", ".git", ".github", "scripts"];

// All translations must succeed - zero tolerance for errors
const MAX_ALLOWED_ERRORS = 0;

interface NavGroup {
  group: string;
  pages: (string | NavGroup)[];
}

interface NavTab {
  tab: string;
  groups: NavGroup[];
  hidden?: boolean;
}

interface DocsConfig {
  navigation: {
    tabs?: NavTab[];
    languages?: unknown[];
    global?: unknown;
  };
}

// Retry configuration for transient failures
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Parallel processing - aggressive parallelism
const PARALLEL_FILES = 50;

let openai: OpenAI;

/**
 * Extracts all page paths from a navigation group (recursively).
 */
function extractPagesFromGroup(group: NavGroup): string[] {
  const pages: string[] = [];
  for (const page of group.pages) {
    if (typeof page === "string") {
      pages.push(page);
    } else {
      pages.push(...extractPagesFromGroup(page));
    }
  }
  return pages;
}

/**
 * Gets all page paths referenced in docs.json navigation.
 */
function getNavReferencedPages(): Set<string> {
  const configContent = fs.readFileSync(DOCS_CONFIG_PATH, "utf8");
  const config: DocsConfig = JSON.parse(configContent);

  const pages = new Set<string>();

  if (config.navigation.tabs) {
    for (const tab of config.navigation.tabs) {
      for (const group of tab.groups) {
        for (const page of extractPagesFromGroup(group)) {
          pages.add(page);
        }
      }
    }
  }

  return pages;
}

/**
 * Validates the OpenAI API key by making a test request
 */
async function validateApiKey(): Promise<void> {
  console.log("Validating OpenAI API key...");

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Reply with OK" }],
      max_tokens: 5,
    });

    if (!response.choices[0]?.message?.content) {
      throw new Error("API returned empty response");
    }

    console.log("✓ OpenAI API key is valid and working\n");
  } catch (err) {
    const error = err as Error & { status?: number; code?: string };

    if (error.status === 401) {
      console.error("::error::OpenAI API key is invalid or expired");
      process.exit(1);
    }

    if (error.status === 429) {
      console.error("::error::OpenAI API rate limit exceeded or quota exhausted");
      process.exit(1);
    }

    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
      console.error("::error::Cannot connect to OpenAI API");
      process.exit(1);
    }

    console.error(`::error::OpenAI API validation failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Finds English MDX files that are referenced in the navigation.
 */
function findEnglishMdxFiles(): string[] {
  const navPages = getNavReferencedPages();
  const files: string[] = [];

  for (const page of navPages) {
    const filePath = `${page}.mdx`;
    const fullPath = path.join(DOCS_ROOT, filePath);

    if (fs.existsSync(fullPath)) {
      files.push(filePath);
    } else {
      console.warn(`Warning: Nav references non-existent file: ${filePath}`);
    }
  }

  return files;
}

/**
 * Checks which translations are missing for a given English file
 */
function getMissingTranslations(englishFile: string): string[] {
  const missing: string[] = [];

  for (const lang of Object.keys(LANGUAGES)) {
    const translatedPath = path.join(DOCS_ROOT, lang, englishFile);
    if (!fs.existsSync(translatedPath)) {
      missing.push(lang);
    }
  }

  return missing;
}

/**
 * Checks if an error is retryable
 */
function isRetryableError(err: unknown): boolean {
  const error = err as Error & { status?: number; code?: string };

  if (error.code === "ECONNRESET" || error.code === "ETIMEDOUT" || error.code === "ENOTFOUND") {
    return true;
  }

  if (error.status && error.status >= 500) {
    return true;
  }

  if (error.status === 429) {
    return true;
  }

  if (error.status === 400) {
    return true;
  }

  return false;
}

/**
 * Mintlify resolves OpenAPI per MDX file; translated pages must reference `{lang}/openapi/*.json`.
 * Rewrites the openapi frontmatter line regardless of what the model returned.
 *
 * @param content - MDX after translation
 * @param lang - Target locale (e.g. `fr`)
 * @returns MDX with corrected openapi path when present
 */
function rewriteOpenapiPathForLanguage(content: string, lang: string): string {
  return content.replace(
    /^openapi:\s*(['"])([\s\S]*?)\1/m,
    (_full, quote: string, value: string) => {
      const trimmed = value.trim();
      const m = trimmed.match(/^(?:[a-z]{2}\/)?openapi\/(\S+\.json)(\s+[\s\S]*)?$/);
      if (!m) {
        return `openapi: ${quote}${value}${quote}`;
      }
      const rest = m[2] ?? "";
      return `openapi: ${quote}${lang}/openapi/${m[1]}${rest}${quote}`;
    }
  );
}

/**
 * Translates MDX content to a target language with retry logic
 */
async function translateContent(
  content: string,
  targetLang: string,
  filePath: string
): Promise<string> {
  const langInfo = LANGUAGES[targetLang];

  const systemPrompt = `You are a professional technical documentation translator. Translate the following MDX documentation from English to ${langInfo.name} (${langInfo.nativeName}).

WHAT TO TRANSLATE:
- Prose text, headings, descriptions
- UI labels and button text in examples
- Alt text for images

WHAT TO PRESERVE EXACTLY (do not translate):
- All MDX/JSX syntax and component names (<Card>, <Tabs>, <CodeGroup>, etc.)
- All code blocks (content between \`\`\` markers)
- All inline code (content in backticks)
- All URLs, links, file paths
- All variable names, function names, identifiers
- Frontmatter keys (only translate 'title' and 'description' values)
- Brand names (Olostep, etc.)
- Standard technical acronyms that are universally used in English (API, SDK, JSON, HTTP, etc.)

STYLE:
- Translate naturally for native speakers - don't be overly literal
- Maintain the same markdown formatting (headers, lists, bold, italic)
- Use informal "you" (e.g., "du" in German, "tu" in French/Spanish/Italian, etc.) - this is developer documentation, keep it casual and direct

OUTPUT FORMAT:
- Output ONLY the raw translated MDX content
- Do NOT wrap in code fences (\`\`\`mdx or \`\`\`)
- Start directly with --- for the frontmatter`;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Translate this MDX file (${filePath}) to ${langInfo.name}:\n\n${content}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 16000,
      });

      let translated = response.choices[0]?.message?.content?.trim();

      if (!translated) {
        throw new Error("LLM returned empty translation");
      }

      // Strip code fences if LLM wrapped the output
      if (translated.startsWith("```")) {
        translated = translated.replace(/^```(?:mdx|markdown)?\n?/, "");
        translated = translated.replace(/\n?```\s*$/, "");
        translated = translated.trim();
      }

      if (!translated.startsWith("---")) {
        throw new Error("Translation missing frontmatter (must start with ---)");
      }

      if (translated.length < content.length * 0.3) {
        throw new Error(
          `Translation suspiciously short (${translated.length} chars vs ${content.length} original)`
        );
      }

      return translated;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const error = err as Error & { status?: number };
      if (error.status === 401 || error.status === 403) {
        throw err;
      }

      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = RETRY_DELAY_MS * attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }
  }

  throw lastError || new Error("Translation failed after all retries");
}

/**
 * Writes translated content to language directory
 */
async function writeTranslation(
  englishFile: string,
  lang: string,
  content: string
): Promise<void> {
  const targetPath = path.join(DOCS_ROOT, lang, englishFile);
  const targetDir = path.dirname(targetPath);

  fs.mkdirSync(targetDir, { recursive: true });
  await fs.promises.writeFile(targetPath, content, "utf8");
}

/**
 * Process items in batches with limited concurrency
 */
async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Translates a file to a specific language
 */
async function translateFileToLang(
  file: string,
  lang: string,
  content: string
): Promise<{ success: boolean; lang: string; translated?: string; error?: string }> {
  try {
    const translated = rewriteOpenapiPathForLanguage(
      await translateContent(content, lang, file),
      lang
    );
    return { success: true, lang, translated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    const error = err as Error & { status?: number };
    if (error.status === 401 || error.status === 403) {
      console.error("\n::error::API authentication failed - stopping");
      process.exit(1);
    }
    if (error.status === 429) {
      console.error("\n::error::Rate limit exceeded - stopping");
      process.exit(1);
    }

    return { success: false, lang, error: message };
  }
}

/**
 * Translates a single file to all specified languages (parallel)
 */
async function translateFileToAllLangs(
  file: string,
  langs: string[]
): Promise<{ file: string; results: { success: boolean; lang: string; error?: string }[] }> {
  const content = fs.readFileSync(path.join(DOCS_ROOT, file), "utf8");

  const results = await Promise.all(
    langs.map((lang) => translateFileToLang(file, lang, content))
  );

  await Promise.all(
    results
      .filter((r) => r.success && r.translated)
      .map((r) => writeTranslation(file, r.lang, r.translated!))
  );

  const langStatus = langs
    .map((lang) => {
      const result = results.find((r) => r.lang === lang);
      return result?.success ? `${lang}✓` : `${lang}✗`;
    })
    .join(" ");

  console.log(`[${file}] ${langStatus}`);

  return { file, results };
}

/**
 * Phase 1: Catch-up - translate all missing pages
 */
async function runCatchup(): Promise<TranslationResult> {
  console.log("\n=== PHASE 1: CATCH-UP ===\n");
  console.log(`Parallelism: ${PARALLEL_FILES} files × all languages\n`);

  const englishFiles = findEnglishMdxFiles();
  console.log(`Found ${englishFiles.length} English MDX files`);

  const filesToTranslate: { file: string; langs: string[] }[] = [];

  for (const file of englishFiles) {
    const missingLangs = getMissingTranslations(file);
    if (missingLangs.length > 0) {
      filesToTranslate.push({ file, langs: missingLangs });
    }
  }

  console.log(`Files needing translation: ${filesToTranslate.length}\n`);

  if (filesToTranslate.length === 0) {
    return { totalTranslations: 0, errors: [] };
  }

  let totalTranslations = 0;
  const errors: TranslationError[] = [];

  const fileResults = await processInBatches(
    filesToTranslate,
    PARALLEL_FILES,
    ({ file, langs }) => translateFileToAllLangs(file, langs)
  );

  for (const { file, results } of fileResults) {
    for (const result of results) {
      if (result.success) {
        totalTranslations++;
      } else {
        errors.push({ file, lang: result.lang, error: result.error || "Unknown error" });
      }
    }
  }

  console.log(`\nCatch-up complete: ${totalTranslations} translations created`);

  return { totalTranslations, errors };
}

/**
 * Phase 2: Incremental - translate only changed files
 */
async function runIncremental(files: string[]): Promise<TranslationResult> {
  console.log("\n=== PHASE 2: INCREMENTAL ===\n");
  console.log(`Parallelism: ${PARALLEL_FILES} files × all languages`);
  console.log(`Translating ${files.length} changed files\n`);

  const allLangs = Object.keys(LANGUAGES);

  const filesToTranslate = files
    .filter((file) => {
      const exists = fs.existsSync(path.join(DOCS_ROOT, file));
      if (!exists) console.log(`Skipping deleted file: ${file}`);
      return exists;
    })
    .map((file) => ({ file, langs: allLangs }));

  if (filesToTranslate.length === 0) {
    return { totalTranslations: 0, errors: [] };
  }

  let totalTranslations = 0;
  const errors: TranslationError[] = [];

  const fileResults = await processInBatches(
    filesToTranslate,
    PARALLEL_FILES,
    ({ file, langs }) => translateFileToAllLangs(file, langs)
  );

  for (const { file, results } of fileResults) {
    for (const result of results) {
      if (result.success) {
        totalTranslations++;
      } else {
        errors.push({ file, lang: result.lang, error: result.error || "Unknown error" });
      }
    }
  }

  console.log(`\nIncremental complete: ${totalTranslations} translations updated`);

  return { totalTranslations, errors };
}

/**
 * Writes to GitHub Actions step summary
 */
function writeToSummary(content: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, content + "\n");
  }
}

/**
 * Checks translation results and handles errors
 */
function checkErrors(result: TranslationResult, phase: string, allowPartialFailure: boolean = false): void {
  const total = result.totalTranslations + result.errors.length;

  if (total === 0) {
    console.log(`\n${phase}: No translations attempted`);
    return;
  }

  console.log(`\n${phase} Summary:`);
  console.log(`  Total successful: ${result.totalTranslations}`);
  console.log(`  Total errors: ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log("\nFailed translations (will be retried on next run):");
    result.errors.forEach((e) => {
      console.log(`::warning file=${e.file},title=Translation Failed::Failed to translate to ${e.lang}: ${e.error}`);
    });

    writeToSummary(`\n### ⚠️ Failed Translations (${phase})\n`);
    writeToSummary("| File | Language | Error |");
    writeToSummary("|------|----------|-------|");
    result.errors.forEach((e) => {
      writeToSummary(`| \`${e.file}\` | ${e.lang} | ${e.error.substring(0, 100)} |`);
    });
    writeToSummary(`\n> These will be automatically retried on the next run.\n`);

    if (allowPartialFailure) {
      console.log(`\n⚠ ${result.errors.length} translation(s) failed but will be retried on next run.`);
      console.log("Continuing with deployment of successful translations...");
    } else {
      console.error(`\n::error::${result.errors.length} translation(s) failed. Build cannot continue.`);
      console.error("Incremental translations must all succeed.");
      process.exit(1);
    }
  }
}

function parseArgs(): { phase: string | undefined; files: string | undefined } {
  const args = process.argv.slice(2);
  const phase = args.find((a) => a.startsWith("--phase="))?.split("=")[1];
  const files = args.find((a) => a.startsWith("--files="))?.split("=")[1];
  return { phase, files };
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("::error::OPENAI_API_KEY environment variable is not set");
    process.exit(1);
  }

  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  console.log("Olostep Docs Translation");
  console.log("========================");
  console.log(
    `Languages: ${Object.values(LANGUAGES)
      .map((l) => l.name)
      .join(", ")}\n`
  );

  await validateApiKey();

  const { phase, files: filesArg } = parseArgs();

  if (phase === "catchup") {
    const result = await runCatchup();
    checkErrors(result, "Catch-up", true);
  } else if (phase === "incremental" && filesArg) {
    const files = filesArg.split(",").filter((f) => f.trim());
    if (files.length > 0) {
      const result = await runIncremental(files);
      checkErrors(result, "Incremental", false);
    } else {
      console.log("No files to translate");
    }
  } else {
    const result = await runCatchup();
    checkErrors(result, "Catch-up", true);
  }

  console.log("\n✓ Translation completed successfully");
}

main().catch((err) => {
  console.error("::error::Translation failed unexpectedly");
  console.error(err);
  process.exit(1);
});
