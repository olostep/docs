#!/usr/bin/env npx ts-node
/**
 * Translates OpenAPI specification files.
 * Only translates specific human-readable fields (description, summary, title).
 * Preserves all technical fields (types, property names, enums, URLs, etc.) exactly.
 *
 * @module translate-openapi
 */

import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";

interface LanguageInfo {
  name: string;
  nativeName: string;
}

const LANGUAGES: Record<string, LanguageInfo> = {
  es: { name: "Spanish", nativeName: "Español" },
  nl: { name: "Dutch", nativeName: "Nederlands" },
  fr: { name: "French", nativeName: "Français" },
  de: { name: "German", nativeName: "Deutsch" },
  zh: { name: "Chinese (Simplified)", nativeName: "简体中文" },
  it: { name: "Italian", nativeName: "Italiano" },
  ja: { name: "Japanese", nativeName: "日本語" },
};

const DOCS_ROOT = path.resolve(__dirname, "..");
const OPENAPI_DIR = path.join(DOCS_ROOT, "openapi");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Fields that contain human-readable text and should be translated
const TRANSLATABLE_FIELDS = new Set(["description", "summary", "title"]);

// Cache translations to avoid redundant API calls for identical strings
const translationCache: Map<string, Map<string, string>> = new Map();

/**
 * Translates a single string to the target language.
 * Uses caching to avoid redundant API calls.
 *
 * @param text - The English text to translate
 * @param lang - Target language code
 * @returns Translated text
 */
async function translateString(text: string, lang: string): Promise<string> {
  if (!text || text.trim().length === 0) {
    return text;
  }

  // Check cache
  if (!translationCache.has(lang)) {
    translationCache.set(lang, new Map());
  }
  const langCache = translationCache.get(lang)!;
  if (langCache.has(text)) {
    return langCache.get(text)!;
  }

  const langInfo = LANGUAGES[lang];
  if (!langInfo) {
    return text;
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: `Translate this API documentation text to ${langInfo.name} (${langInfo.nativeName}).

PRESERVE (do not translate):
- Standard technical acronyms universally used in English
- Brand names
- Code references in backticks
- Quoted values (e.g., "file", "completed")

Output ONLY the translated text.`,
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    const translated = response.choices[0]?.message?.content?.trim() || text;
    langCache.set(text, translated);
    return translated;
  } catch (error) {
    console.warn(`  Warning: Failed to translate "${text.substring(0, 50)}..." to ${lang}`);
    return text;
  }
}

/**
 * Recursively walks through an object and translates only the specified fields.
 * All other fields are preserved exactly.
 *
 * @param obj - The object to process
 * @param lang - Target language code
 * @returns New object with translated fields
 */
async function translateObject(obj: unknown, lang: string): Promise<unknown> {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    const results: unknown[] = [];
    for (const item of obj) {
      results.push(await translateObject(item, lang));
    }
    return results;
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (TRANSLATABLE_FIELDS.has(key) && typeof value === "string") {
        result[key] = await translateString(value, lang);
      } else {
        result[key] = await translateObject(value, lang);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Extracts all translatable strings from an OpenAPI spec for batch translation.
 * This allows us to translate all strings at once, reducing API calls.
 */
function extractTranslatableStrings(obj: unknown, strings: Set<string> = new Set()): Set<string> {
  if (obj === null || obj === undefined) {
    return strings;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractTranslatableStrings(item, strings);
    }
    return strings;
  }

  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (TRANSLATABLE_FIELDS.has(key) && typeof value === "string" && value.trim()) {
        strings.add(value);
      } else {
        extractTranslatableStrings(value, strings);
      }
    }
  }

  return strings;
}

/**
 * Batch translates an array of strings to a target language.
 * Groups strings to minimize API calls.
 */
async function batchTranslateStrings(
  strings: string[],
  lang: string
): Promise<Map<string, string>> {
  const langInfo = LANGUAGES[lang];
  if (!langInfo) {
    return new Map(strings.map((s) => [s, s]));
  }

  // Filter out already cached strings
  if (!translationCache.has(lang)) {
    translationCache.set(lang, new Map());
  }
  const langCache = translationCache.get(lang)!;

  const toTranslate = strings.filter((s) => !langCache.has(s));

  if (toTranslate.length === 0) {
    return langCache;
  }

  // Batch translate in groups of 20 to avoid token limits
  const BATCH_SIZE = 20;
  for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
    const batch = toTranslate.slice(i, i + BATCH_SIZE);
    const numbered = batch.map((s, idx) => `[${idx + 1}] ${s}`).join("\n\n");

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.1,
        max_tokens: 4000,
        messages: [
          {
            role: "system",
            content: `Translate these API documentation texts to ${langInfo.name} (${langInfo.nativeName}).

FORMAT: Each text is numbered [1], [2], etc. Output translations in the same format.

PRESERVE (do not translate):
- Standard technical acronyms universally used in English
- Brand names
- Quoted values (e.g., "file", "completed")
- Technical identifiers (e.g., file_id, expires_in)

Output ONLY the numbered translations.`,
          },
          {
            role: "user",
            content: numbered,
          },
        ],
      });

      const output = response.choices[0]?.message?.content || "";
      
      // Parse the numbered output
      const lines = output.split("\n");
      let currentNum = 0;
      let currentText = "";

      for (const line of lines) {
        const match = line.match(/^\[(\d+)\]\s*(.*)/);
        if (match) {
          // Save previous if exists
          if (currentNum > 0 && currentNum <= batch.length) {
            langCache.set(batch[currentNum - 1], currentText.trim());
          }
          currentNum = parseInt(match[1], 10);
          currentText = match[2];
        } else if (currentNum > 0) {
          currentText += " " + line;
        }
      }
      // Save last one
      if (currentNum > 0 && currentNum <= batch.length) {
        langCache.set(batch[currentNum - 1], currentText.trim());
      }

      // Fallback for any missing translations
      for (const s of batch) {
        if (!langCache.has(s)) {
          langCache.set(s, s);
        }
      }
    } catch (error) {
      console.warn(`  Warning: Batch translation failed for ${lang}, using originals`);
      for (const s of batch) {
        langCache.set(s, s);
      }
    }
  }

  return langCache;
}

/**
 * Applies cached translations to an object.
 */
function applyTranslations(
  obj: unknown,
  translations: Map<string, string>
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => applyTranslations(item, translations));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (TRANSLATABLE_FIELDS.has(key) && typeof value === "string") {
        result[key] = translations.get(value) || value;
      } else {
        result[key] = applyTranslations(value, translations);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Translates a single OpenAPI spec file to all languages.
 */
async function translateOpenApiFile(filename: string): Promise<void> {
  const filepath = path.join(OPENAPI_DIR, filename);
  const content = fs.readFileSync(filepath, "utf8");
  const spec = JSON.parse(content);

  // Extract all translatable strings
  const strings = extractTranslatableStrings(spec);
  console.log(`  Found ${strings.size} unique translatable strings`);

  const stringArray = Array.from(strings);

  // Translate to each language
  for (const lang of Object.keys(LANGUAGES)) {
    console.log(`  Translating to ${lang}...`);

    // Batch translate all strings
    const translations = await batchTranslateStrings(stringArray, lang);

    // Apply translations to create new spec
    const translatedSpec = applyTranslations(spec, translations);

    // Write to language-specific directory
    const langDir = path.join(DOCS_ROOT, lang, "openapi");
    fs.mkdirSync(langDir, { recursive: true });
    fs.writeFileSync(
      path.join(langDir, filename),
      JSON.stringify(translatedSpec, null, 2),
      "utf8"
    );
  }
}

async function main(): Promise<void> {
  console.log("OpenAPI Translation");
  console.log("===================\n");

  if (!process.env.OPENAI_API_KEY) {
    console.error("ERROR: OPENAI_API_KEY environment variable not set");
    process.exit(1);
  }

  // Get all OpenAPI spec files
  const files = fs.readdirSync(OPENAPI_DIR).filter((f) => f.endsWith(".json"));
  console.log(`Found ${files.length} OpenAPI spec files\n`);

  for (const file of files) {
    console.log(`Processing ${file}...`);
    await translateOpenApiFile(file);
    console.log(`  Done\n`);
  }

  console.log("✓ OpenAPI translation complete");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
