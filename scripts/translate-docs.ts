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

interface Glossary {
  keepEnglish: string[];
  brandTerms: string[];
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
  es: { name: "Spanish", nativeName: "Español" },
  nl: { name: "Dutch", nativeName: "Nederlands" },
  fr: { name: "French", nativeName: "Français" },
  zh: { name: "Chinese (Simplified)", nativeName: "简体中文" },
  it: { name: "Italian", nativeName: "Italiano" },
  ja: { name: "Japanese", nativeName: "日本語" },
};

const DOCS_ROOT = path.resolve(__dirname, "..");
const GLOSSARY_PATH = path.join(__dirname, "glossary.json");

const SKIP_DIRS = ["node_modules", ".git", ".github", "scripts"];

// All translations must succeed - zero tolerance for errors
const MAX_ALLOWED_ERRORS = 0;

// Retry configuration for transient failures
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Parallel processing - translate multiple languages concurrently
const PARALLEL_LANGUAGES = 3;

function loadGlossary(): Glossary {
  try {
    return JSON.parse(fs.readFileSync(GLOSSARY_PATH, "utf8"));
  } catch {
    console.log("No glossary found, using defaults");
    return {
      keepEnglish: [
        "API",
        "SDK",
        "JSON",
        "MDX",
        "URL",
        "HTTP",
        "REST",
        "OAuth",
        "webhook",
        "endpoint",
      ],
      brandTerms: ["Olostep", "Mintlify"],
    };
  }
}

const glossary = loadGlossary();

let openai: OpenAI;

/**
 * Validates the OpenAI API key by making a test request
 * @throws Error if the API key is invalid or the API is unreachable
 */
async function validateApiKey(): Promise<void> {
  console.log("Validating OpenAI API key...");

  try {
    // Make a minimal API call to verify the key works
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
      console.error("");
      console.error("The API key was rejected by OpenAI. Please:");
      console.error("1. Verify your API key at https://platform.openai.com/api-keys");
      console.error("2. Update the OPENAI_API_KEY secret in GitHub");
      process.exit(1);
    }

    if (error.status === 429) {
      console.error("::error::OpenAI API rate limit exceeded or quota exhausted");
      console.error("");
      console.error("Please check your OpenAI account:");
      console.error("- Verify you have available credits");
      console.error("- Check rate limits at https://platform.openai.com/usage");
      process.exit(1);
    }

    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
      console.error("::error::Cannot connect to OpenAI API");
      console.error("");
      console.error("Network error - unable to reach api.openai.com");
      process.exit(1);
    }

    console.error(`::error::OpenAI API validation failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Finds all English MDX files (not in language directories)
 */
function findEnglishMdxFiles(): string[] {
  const files: string[] = [];
  const langDirs = Object.keys(LANGUAGES);

  function walk(dir: string, relativePath: string = ""): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relativePath, entry.name);

      if (entry.isDirectory()) {
        if (langDirs.includes(entry.name) || SKIP_DIRS.includes(entry.name)) {
          continue;
        }
        walk(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
        files.push(relPath);
      }
    }
  }

  walk(DOCS_ROOT);
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
 * Checks if an error is retryable (transient network/rate issues)
 */
function isRetryableError(err: unknown): boolean {
  const error = err as Error & { status?: number; code?: string };
  
  // Network errors
  if (error.code === "ECONNRESET" || error.code === "ETIMEDOUT" || error.code === "ENOTFOUND") {
    return true;
  }
  
  // Server errors (5xx)
  if (error.status && error.status >= 500) {
    return true;
  }
  
  // Rate limit (429) - can retry after delay
  if (error.status === 429) {
    return true;
  }
  
  // Bad request (400) - sometimes OpenAI has transient JSON parsing issues
  if (error.status === 400) {
    return true;
  }
  
  return false;
}

/**
 * Translates MDX content to a target language with retry logic
 * @throws Error if translation fails after all retries
 */
async function translateContent(
  content: string,
  targetLang: string,
  filePath: string
): Promise<string> {
  const langInfo = LANGUAGES[targetLang];

  const systemPrompt = `You are a professional technical documentation translator. Translate the following MDX documentation from English to ${langInfo.name} (${langInfo.nativeName}).

CRITICAL RULES:
1. PRESERVE ALL MDX/JSX syntax exactly as-is (components like <Card>, <Tabs>, <CodeGroup>, etc.)
2. PRESERVE ALL code blocks exactly as-is (content between \`\`\` markers)
3. PRESERVE ALL frontmatter structure (YAML between --- markers) - only translate the 'title' and 'description' values
4. PRESERVE ALL URLs, links, and file paths exactly as-is
5. PRESERVE ALL variable names, function names, and technical identifiers
6. Keep these terms in English: ${glossary.keepEnglish.join(", ")}
7. Keep brand names as-is: ${glossary.brandTerms.join(", ")}
8. Translate naturally for the target audience - don't be overly literal
9. Maintain the same markdown formatting (headers, lists, bold, italic, etc.)

Output ONLY the translated MDX content, nothing else.`;

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

      const translated = response.choices[0]?.message?.content?.trim();

      if (!translated) {
        throw new Error("LLM returned empty translation");
      }

      // Basic sanity check: translated content should have reasonable length
      if (translated.length < content.length * 0.3) {
        throw new Error(
          `Translation suspiciously short (${translated.length} chars vs ${content.length} original)`
        );
      }

      return translated;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      // Don't retry auth errors - they won't succeed
      const error = err as Error & { status?: number };
      if (error.status === 401 || error.status === 403) {
        throw err;
      }
      
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = RETRY_DELAY_MS * attempt; // Exponential backoff
        console.log(`    ⚠ Attempt ${attempt} failed, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else if (attempt === MAX_RETRIES) {
        throw lastError;
      } else {
        // Non-retryable error
        throw err;
      }
    }
  }
  
  throw lastError ?? new Error("Translation failed after all retries");
}

/**
 * Writes translated content to the appropriate language directory
 */
function writeTranslation(
  englishFile: string,
  lang: string,
  content: string
): void {
  const targetPath = path.join(DOCS_ROOT, lang, englishFile);
  const targetDir = path.dirname(targetPath);

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");

  console.log(`  ✓ Written: ${lang}/${englishFile}`);
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
 * Translates a file to a specific language, returning result
 */
async function translateFileToLang(
  file: string,
  lang: string,
  content: string
): Promise<{ success: boolean; lang: string; error?: string }> {
  try {
    console.log(`  → ${LANGUAGES[lang].name}...`);
    const translated = await translateContent(content, lang, file);
    writeTranslation(file, lang, translated);
    return { success: true, lang };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${LANGUAGES[lang].name}: ${message}`);
    
    // Check for fatal API errors
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
 * Phase 1: Catch-up - translate all missing pages (parallel per file)
 */
async function runCatchup(): Promise<TranslationResult> {
  console.log("\n=== PHASE 1: CATCH-UP ===\n");

  const englishFiles = findEnglishMdxFiles();
  console.log(`Found ${englishFiles.length} English MDX files\n`);

  let totalTranslations = 0;
  const errors: TranslationError[] = [];

  for (const file of englishFiles) {
    const missingLangs = getMissingTranslations(file);

    if (missingLangs.length === 0) {
      continue;
    }

    console.log(`\n${file} - translating to ${missingLangs.length} languages (parallel)`);

    const content = fs.readFileSync(path.join(DOCS_ROOT, file), "utf8");

    // Translate to all missing languages in parallel batches
    const results = await processInBatches(
      missingLangs,
      PARALLEL_LANGUAGES,
      (lang) => translateFileToLang(file, lang, content)
    );

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
 * Phase 2: Incremental - translate only changed files (parallel per file)
 */
async function runIncremental(files: string[]): Promise<TranslationResult> {
  console.log("\n=== PHASE 2: INCREMENTAL ===\n");
  console.log(`Translating ${files.length} changed files\n`);

  let totalTranslations = 0;
  const errors: TranslationError[] = [];
  const allLangs = Object.keys(LANGUAGES);

  for (const file of files) {
    const fullPath = path.join(DOCS_ROOT, file);

    if (!fs.existsSync(fullPath)) {
      console.log(`Skipping deleted file: ${file}`);
      continue;
    }

    console.log(`\n${file} - translating to ${allLangs.length} languages (parallel)`);
    const content = fs.readFileSync(fullPath, "utf8");

    // Translate to all languages in parallel batches
    const results = await processInBatches(
      allLangs,
      PARALLEL_LANGUAGES,
      (lang) => translateFileToLang(file, lang, content)
    );

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
 * Checks translation results and handles errors appropriately
 * 
 * @param result - Translation results
 * @param phase - Phase name for logging
 * @param allowPartialFailure - If true, log errors but don't fail (for catch-up phase)
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
      console.log(`  ::warning file=${e.file}::Failed to translate to ${e.lang}: ${e.error}`);
    });

    if (allowPartialFailure) {
      // For catch-up: just warn, don't fail. Failed files will be picked up next time
      // since they weren't written to disk
      console.log(`\n⚠ ${result.errors.length} translation(s) failed but will be retried on next run.`);
      console.log("Continuing with deployment of successful translations...");
    } else {
      // For incremental: fail the build since these are user-changed files
      console.error(`\n::error::${result.errors.length} translation(s) failed. Build cannot continue.`);
      console.error("Incremental translations must all succeed.");
      process.exit(1);
    }
  }
}

// Parse CLI arguments
function parseArgs(): { phase: string | undefined; files: string | undefined } {
  const args = process.argv.slice(2);
  const phase = args.find((a) => a.startsWith("--phase="))?.split("=")[1];
  const files = args.find((a) => a.startsWith("--files="))?.split("=")[1];
  return { phase, files };
}

async function main(): Promise<void> {
  // Check for API key
  if (!process.env.OPENAI_API_KEY) {
    console.error("::error::OPENAI_API_KEY environment variable is not set");
    console.error("");
    console.error("Please ensure the OPENAI_API_KEY secret is configured in GitHub.");
    process.exit(1);
  }

  // Initialize OpenAI client
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

  // Validate API key before starting
  await validateApiKey();

  const { phase, files: filesArg } = parseArgs();

  if (phase === "catchup") {
    const result = await runCatchup();
    // Allow partial failure for catch-up - failed files will be retried next run
    checkErrors(result, "Catch-up", true);
  } else if (phase === "incremental" && filesArg) {
    const files = filesArg.split(",").filter((f) => f.trim());
    if (files.length > 0) {
      const result = await runIncremental(files);
      // Incremental must succeed - these are user-changed files
      checkErrors(result, "Incremental", false);
    } else {
      console.log("No files to translate");
    }
  } else {
    // Default: run catchup only
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
