#!/usr/bin/env npx ts-node
/**
 * Updates docs.json to include language configurations for i18n.
 * Preserves the exact navigation structure (tabs) for each language.
 * Translates navigation labels (tab names, group names) using OpenAI.
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

interface LanguageConfig {
  language: string;
  default?: boolean;
  groups: NavGroup[];
  openapi?: string[];
}

// Only French enabled for initial test - uncomment others after validation
const LANGUAGES: Record<string, LanguageInfo> = {
  fr: { name: "French", nativeName: "Français" },
  // es: { name: "Spanish", nativeName: "Español" },
  // nl: { name: "Dutch", nativeName: "Nederlands" },
  // de: { name: "German", nativeName: "Deutsch" },
  // zh: { name: "Chinese (Simplified)", nativeName: "简体中文" },
  // it: { name: "Italian", nativeName: "Italiano" },
  // ja: { name: "Japanese", nativeName: "日本語" },
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
 */
function getLangOpenApiFiles(lang: string): string[] {
  const langOpenApiDir = path.join(DOCS_ROOT, lang, "openapi");

  if (!fs.existsSync(langOpenApiDir)) {
    return [];
  }

  return fs
    .readdirSync(langOpenApiDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => `${lang}/openapi/${f}`);
}

const translationCache: Map<string, Map<string, string>> = new Map();

/**
 * Translates a navigation label to the target language.
 */
async function translateLabel(label: string, lang: string): Promise<string> {
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
Do NOT translate brand names like "Olostep", "SDK", "API".
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
    console.warn(`Warning: Failed to translate "${label}" to ${lang}, using original`);
    return label;
  }
}

/**
 * Translates a navigation group and its nested groups, prefixing page paths
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
 * Translates page references (handles nested groups).
 * 
 * # Note: Page paths are NOT prefixed with lang code.
 * Mintlify handles the lang prefix via URL routing automatically.
 * The files live at fr/get-started/welcome.mdx but nav uses get-started/welcome.
 */
async function translatePages(
  pages: (string | NavGroup)[],
  lang: string
): Promise<(string | NavGroup)[]> {
  const results: (string | NavGroup)[] = [];
  for (const page of pages) {
    if (typeof page === "string") {
      // Keep page path as-is - Mintlify resolves based on URL lang prefix
      results.push(page);
    } else {
      results.push(await translateGroup(page, lang));
    }
  }
  return results;
}

/**
 * Creates a translated tab with all groups and page paths prefixed
 */
async function translateTab(tab: NavTab, lang: string): Promise<NavTab> {
  const translatedTabName = await translateLabel(tab.tab, lang);
  const translatedGroups: NavGroup[] = [];

  for (const group of tab.groups) {
    translatedGroups.push(await translateGroup(group, lang));
  }

  const result: NavTab = {
    ...tab,
    tab: translatedTabName,
    groups: translatedGroups,
  };

  // Add language-specific OpenAPI for API tabs
  if (tab.tab.toLowerCase().includes("api") || tab.tab.toLowerCase().includes("reference")) {
    const langOpenApi = getLangOpenApiFiles(lang);
    if (langOpenApi.length > 0) {
      result.openapi = langOpenApi;
    }
  }

  return result;
}

/**
 * Checks if translations exist for a language
 */
function hasTranslations(lang: string): boolean {
  const langDir = path.join(DOCS_ROOT, lang);
  if (!fs.existsSync(langDir)) {
    return false;
  }

  const files = fs.readdirSync(langDir, { recursive: true }) as string[];
  return files.some((f) => f.endsWith(".mdx"));
}

/**
 * Flattens tabs into a single groups array.
 * Mintlify i18n requires groups at the language level, not tabs.
 * We preserve all groups from non-hidden tabs.
 */
function flattenTabsToGroups(tabs: NavTab[]): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const tab of tabs) {
    if (tab.hidden) continue;
    groups.push(...tab.groups);
  }
  return groups;
}

/**
 * Flattens and translates tabs into groups for a language.
 */
async function flattenAndTranslateTabsToGroups(
  tabs: NavTab[],
  lang: string
): Promise<NavGroup[]> {
  const groups: NavGroup[] = [];
  for (const tab of tabs) {
    if (tab.hidden) continue;
    for (const group of tab.groups) {
      groups.push(await translateGroup(group, lang));
    }
  }
  return groups;
}

async function main(): Promise<void> {
  console.log("Updating docs.json with language configurations...\n");

  const configContent = fs.readFileSync(DOCS_CONFIG_PATH, "utf8");
  const config: DocsConfig = JSON.parse(configContent);

  const availableLangs = Object.keys(LANGUAGES).filter(hasTranslations);
  console.log(`Languages with translations: ${availableLangs.join(", ") || "none"}`);

  if (availableLangs.length === 0) {
    console.log("No translations found, keeping original config");
    return;
  }

  const englishTabs = config.navigation.tabs;
  if (!englishTabs) {
    console.error("No tabs found in navigation");
    process.exit(1);
  }

  console.log(`English tabs: ${englishTabs.map((t) => t.tab).join(", ")}`);

  // Flatten English tabs to groups for i18n (Mintlify requires groups at language level)
  const englishGroups = flattenTabsToGroups(englishTabs);
  console.log(`Flattened to ${englishGroups.length} groups for i18n`);

  // Build languages array with groups (not tabs)
  const languages: LanguageConfig[] = [
    {
      language: "en",
      default: true,
      groups: englishGroups,
    },
  ];

  console.log("\nTranslating navigation for each language...");
  for (const lang of availableLangs) {
    console.log(`  ${lang}: translating groups...`);

    const translatedGroups = await flattenAndTranslateTabsToGroups(englishTabs, lang);

    const langConfig: LanguageConfig = {
      language: lang,
      groups: translatedGroups,
    };

    const langOpenApi = getLangOpenApiFiles(lang);
    if (langOpenApi.length > 0) {
      langConfig.openapi = langOpenApi;
    }

    languages.push(langConfig);
  }

  // Build new config preserving all other settings
  const newConfig: DocsConfig = {
    ...config,
    navigation: {
      languages,
      global: config.navigation.global,
    },
  };

  fs.writeFileSync(DOCS_CONFIG_PATH, JSON.stringify(newConfig, null, 2), "utf8");

  console.log(`\n✓ Updated docs.json with ${languages.length} languages:`);
  languages.forEach((l) => {
    const info = l.language === "en" ? "English" : LANGUAGES[l.language]?.name;
    console.log(`  - ${l.language}: ${info}${l.default ? " (default)" : ""}`);
  });

  // Output preview of structure for validation
  console.log("\n=== Structure Preview ===");
  console.log(JSON.stringify(newConfig.navigation, null, 2).slice(0, 1500) + "...");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
