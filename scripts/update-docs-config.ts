#!/usr/bin/env npx ts-node
/**
 * Updates docs.json to include language configurations for i18n.
 * Transforms the existing navigation structure into a multi-language format.
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
}

interface DocsConfig {
  navigation: {
    tabs?: NavTab[];
    languages?: LanguageConfig[];
    global?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

interface LanguageConfig {
  language: string;
  default?: boolean;
  tabs: NavTab[];
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
const DOCS_CONFIG_PATH = path.join(DOCS_ROOT, "docs.json");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    console.warn(`Warning: Failed to translate "${label}" to ${lang}, using original`);
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
 * Creates a language-specific navigation tab with translated labels
 */
async function createLangTab(tab: NavTab, lang: string): Promise<NavTab> {
  const translatedTabName = await translateLabel(tab.tab, lang);
  const translatedGroups: NavGroup[] = [];

  for (const group of tab.groups) {
    translatedGroups.push(await translateGroup(group, lang));
  }

  return {
    ...tab,
    tab: translatedTabName,
    groups: translatedGroups,
  };
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
  console.log(`Languages with translations: ${availableLangs.join(", ") || "none"}`);

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

  // Build languages array
  const languages: LanguageConfig[] = [
    // English (default)
    {
      language: "en",
      default: true,
      tabs: englishTabs,
    },
  ];

  // Add each available language with translated labels
  console.log("\nTranslating navigation labels...");
  for (const lang of availableLangs) {
    console.log(`  Translating labels for ${lang}...`);
    const translatedTabs: NavTab[] = [];
    for (const tab of englishTabs) {
      translatedTabs.push(await createLangTab(tab, lang));
    }
    languages.push({
      language: lang,
      tabs: translatedTabs,
    });
  }

  // Update config
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
