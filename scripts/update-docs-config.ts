#!/usr/bin/env npx ts-node
/**
 * Updates docs.json to include language configurations for i18n.
 * Transforms the existing navigation structure into a multi-language format.
 * Translates navigation labels (group names) using OpenAI.
 *
 * # Note: Mintlify i18n expects `groups` at the language level, NOT `tabs`.
 * We flatten all tabs into a single groups array per language.
 *
 * @module update-docs-config
 */

import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";

interface LanguageInfo {
  name: string;
  nativeName: string;
}

interface NavGroup {
  group: string;
  pages: (string | NavGroup)[];
  icon?: string;
}

interface NavTab {
  tab: string;
  groups: NavGroup[];
  hidden?: boolean;
  openapi?: string | string[];
}

interface DocsConfig {
  navigation: {
    tabs?: NavTab[];
    languages?: LanguageConfig[];
    global?: Record<string, unknown>;
  };
  openapi?: string[];
  [key: string]: unknown;
}

/** Mintlify i18n expects `groups` at language level, not `tabs`. */
interface LanguageConfig {
  language: string;
  default?: boolean;
  groups: NavGroup[];
  openapi?: string[];
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
const DOCS_CONFIG_PATH = path.join(DOCS_ROOT, "docs.json");
const OPENAPI_DIR = path.join(DOCS_ROOT, "openapi");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Gets the list of OpenAPI spec files from the openapi directory
 */
function getOpenApiFiles(): string[] {
  if (!fs.existsSync(OPENAPI_DIR)) {
    return [];
  }
  return fs
    .readdirSync(OPENAPI_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => `openapi/${f}`);
}

/**
 * Gets language-specific OpenAPI paths.
 * If translated OpenAPI files exist, use them; otherwise fall back to English.
 */
function getLangOpenApiFiles(lang: string): string[] {
  const langOpenApiDir = path.join(DOCS_ROOT, lang, "openapi");
  const englishFiles = getOpenApiFiles();

  if (!fs.existsSync(langOpenApiDir)) {
    return englishFiles;
  }

  const langFiles = fs
    .readdirSync(langOpenApiDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => `${lang}/openapi/${f}`);

  return langFiles.length > 0 ? langFiles : englishFiles;
}

// Cache for translated labels to avoid redundant API calls
const translationCache: Map<string, Map<string, string>> = new Map();

/**
 * Translates a navigation label to the target language.
 * Uses a simple prompt optimized for short UI strings.
 *
 * @param label - The English label to translate
 * @param lang - Target language code
 * @returns Translated label
 */
async function translateLabel(label: string, lang: string): Promise<string> {
  // Check cache first
  if (!translationCache.has(lang)) {
    translationCache.set(lang, new Map());
  }
  const langCache = translationCache.get(lang)!;
  if (langCache.has(label)) {
    return langCache.get(label)!;
  }

  const langInfo = LANGUAGES[lang];
  if (!langInfo) {
    return label;
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.1,
      max_tokens: 100,
      messages: [
        {
          role: "system",
          content: `You are a translator. Translate the following navigation label to ${langInfo.name} (${langInfo.nativeName}). 
Keep it concise and natural for UI navigation. 
Do NOT translate brand names like "Olostep".
Output ONLY the translated text, nothing else.`,
        },
        {
          role: "user",
          content: label,
        },
      ],
    });

    const translated = response.choices[0]?.message?.content?.trim() || label;
    langCache.set(label, translated);
    return translated;
  } catch (error) {
    console.warn(
      `Warning: Failed to translate "${label}" to ${lang}, using original`
    );
    return label;
  }
}

/**
 * Translates a navigation group and its nested groups
 */
async function translateGroup(group: NavGroup, lang: string): Promise<NavGroup> {
  const translatedGroupName = await translateLabel(group.group, lang);
  const translatedPages = await translatePages(group.pages, lang);

  return {
    ...group,
    group: translatedGroupName,
    pages: translatedPages,
  };
}

/**
 * Translates page references (handles nested groups)
 */
async function translatePages(
  pages: (string | NavGroup)[],
  lang: string
): Promise<(string | NavGroup)[]> {
  const results: (string | NavGroup)[] = [];
  for (const page of pages) {
    if (typeof page === "string") {
      results.push(`${lang}/${page}`);
    } else {
      results.push(await translateGroup(page, lang));
    }
  }
  return results;
}

/**
 * Flattens tabs into a single groups array.
 * Mintlify i18n expects groups at the language level, not tabs.
 *
 * @param tabs - Array of navigation tabs
 * @returns Flattened array of groups from all non-hidden tabs
 */
function flattenTabsToGroups(tabs: NavTab[]): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const tab of tabs) {
    // Skip hidden tabs (internal, developer guides, etc.)
    if (tab.hidden) {
      continue;
    }
    groups.push(...tab.groups);
  }
  return groups;
}

/**
 * Creates translated groups for a language from English tabs.
 *
 * @param tabs - English tabs to translate
 * @param lang - Target language code
 * @returns Translated and flattened groups
 */
async function createLangGroups(
  tabs: NavTab[],
  lang: string
): Promise<NavGroup[]> {
  const translatedGroups: NavGroup[] = [];
  for (const tab of tabs) {
    // Skip hidden tabs
    if (tab.hidden) {
      continue;
    }
    for (const group of tab.groups) {
      translatedGroups.push(await translateGroup(group, lang));
    }
  }
  return translatedGroups;
}

/**
 * Checks if translations exist for a language
 */
function hasTranslations(lang: string): boolean {
  const langDir = path.join(DOCS_ROOT, lang);
  if (!fs.existsSync(langDir)) {
    return false;
  }

  // Check if there's at least one MDX file
  const files = fs.readdirSync(langDir, { recursive: true }) as string[];
  return files.some((f) => f.endsWith(".mdx"));
}

async function main(): Promise<void> {
  console.log("Updating docs.json with language configurations...\n");

  // Read current config
  const configContent = fs.readFileSync(DOCS_CONFIG_PATH, "utf8");
  const config: DocsConfig = JSON.parse(configContent);

  // Check which languages have translations
  const availableLangs = Object.keys(LANGUAGES).filter(hasTranslations);
  console.log(
    `Languages with translations: ${availableLangs.join(", ") || "none"}`
  );

  if (availableLangs.length === 0) {
    console.log("No translations found, keeping original config");
    return;
  }

  // Get current tabs (English)
  const englishTabs = config.navigation.tabs;
  if (!englishTabs) {
    console.error("No tabs found in navigation");
    process.exit(1);
  }

  // Get root-level OpenAPI config
  const rootOpenApi = config.openapi || [];
  console.log(`OpenAPI specs: ${rootOpenApi.length} files`);

  // Flatten English tabs into groups (Mintlify i18n needs groups, not tabs)
  const englishGroups = flattenTabsToGroups(englishTabs);

  // Build languages array with groups (not tabs)
  const languages: LanguageConfig[] = [
    {
      language: "en",
      default: true,
      groups: englishGroups,
    },
  ];

  // Add each available language with translated labels
  console.log("\nTranslating navigation labels...");
  for (const lang of availableLangs) {
    console.log(`  Translating labels for ${lang}...`);
    const langOpenApi = getLangOpenApiFiles(lang);
    console.log(`    OpenAPI specs: ${langOpenApi.length} files`);

    const translatedGroups = await createLangGroups(englishTabs, lang);

    const langConfig: LanguageConfig = {
      language: lang,
      groups: translatedGroups,
    };

    // Add lang-specific OpenAPI if available
    if (langOpenApi.length > 0) {
      langConfig.openapi = langOpenApi;
    }

    languages.push(langConfig);
  }

  // Update config - keep openapi at root for English, languages handle their own
  const newConfig: DocsConfig = {
    ...config,
    navigation: {
      languages,
      global: config.navigation.global,
    },
  };

  // Write updated config
  fs.writeFileSync(DOCS_CONFIG_PATH, JSON.stringify(newConfig, null, 2), "utf8");

  console.log(`\n✓ Updated docs.json with ${languages.length} languages:`);
  languages.forEach((l) => {
    const info = l.language === "en" ? "English" : LANGUAGES[l.language]?.name;
    console.log(`  - ${l.language}: ${info}${l.default ? " (default)" : ""}`);
  });
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
