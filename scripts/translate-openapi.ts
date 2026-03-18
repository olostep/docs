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
  de: { name: "German", nativeName: "Deutsch" },
  fr: { name: "French", nativeName: "Français" },
  es: { name: "Spanish", nativeName: "Español" },
  nl: { name: "Dutch", nativeName: "Nederlands" },
  zh: { name: "Chinese (Simplified)", nativeName: "简体中文" },
  it: { name: "Italian", nativeName: "Italiano" },
  ja: { name: "Japanese", nativeName: "日本語" },
};

const DOCS_ROOT = path.resolve(__dirname, "..");
const OPENAPI_DIR = path.join(DOCS_ROOT, "openapi");

let openai: OpenAI;

// Fields that contain human-readable text and should be translated
const TRANSLATABLE_FIELDS = new Set(["description", "summary", "title"]);

// Cache translations to avoid redundant API calls for identical strings
const translationCache: Map<string, Map<string, string>> = new Map();

/**
 * Extracts all translatable strings from an OpenAPI spec for batch translation.
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
 */
async function batchTranslateStrings(
  strings: string[],
  lang: string
): Promise<Map<string, string>> {
  const langInfo = LANGUAGES[lang];
  if (!langInfo) {
    return new Map(strings.map((s) => [s, s]));
  }

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
- Standard technical acronyms universally used in English (API, URL, JSON, HTTP, etc.)
- Brand names (Olostep)
- Quoted values (e.g., "file", "completed")
- Technical identifiers (e.g., file_id, expires_in)
- Code references in backticks

STYLE:
- Use informal "you" (e.g., "du" in German, "tu" in French) - this is developer documentation
- Keep it casual and direct

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
          if (currentNum > 0 && currentNum <= batch.length) {
            langCache.set(batch[currentNum - 1], currentText.trim());
          }
          currentNum = parseInt(match[1], 10);
          currentText = match[2];
        } else if (currentNum > 0) {
          currentText += " " + line;
        }
      }
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

  const strings = extractTranslatableStrings(spec);
  const stringArray = Array.from(strings);

  const langs = Object.keys(LANGUAGES);

  const results = await Promise.all(
    langs.map(async (lang) => {
      try {
        const translations = await batchTranslateStrings(stringArray, lang);
        const translatedSpec = applyTranslations(spec, translations);

        const langDir = path.join(DOCS_ROOT, lang, "openapi");
        fs.mkdirSync(langDir, { recursive: true });
        await fs.promises.writeFile(
          path.join(langDir, filename),
          JSON.stringify(translatedSpec, null, 2),
          "utf8"
        );
        return { lang, success: true };
      } catch (err) {
        return { lang, success: false, error: err };
      }
    })
  );

  const langStatus = results
    .map((r) => (r.success ? `${r.lang}✓` : `${r.lang}✗`))
    .join(" ");
  console.log(`[${filename}] (${strings.size} strings) ${langStatus}`);
}

const PARALLEL_FILES = 3;

async function main(): Promise<void> {
  console.log("OpenAPI Translation");
  console.log("===================\n");

  if (!process.env.OPENAI_API_KEY) {
    console.error("ERROR: OPENAI_API_KEY environment variable not set");
    process.exit(1);
  }

  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const files = fs.readdirSync(OPENAPI_DIR).filter((f) => f.endsWith(".json"));
  console.log(`Found ${files.length} OpenAPI spec files`);
  console.log(`Languages: ${Object.keys(LANGUAGES).join(", ")}`);
  console.log(`Parallelism: ${PARALLEL_FILES} files\n`);

  for (let i = 0; i < files.length; i += PARALLEL_FILES) {
    const batch = files.slice(i, i + PARALLEL_FILES);
    await Promise.all(batch.map((file) => translateOpenApiFile(file)));
  }

  console.log("\n✓ OpenAPI translation complete");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
