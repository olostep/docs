#!/usr/bin/env npx ts-node
/**
 * Updates docs.json to include language configurations for i18n.
 * Transforms the existing navigation structure into a multi-language format.
 *
 * @module update-docs-config
 */

import * as fs from "fs";
import * as path from "path";

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

/**
 * Prefixes all page paths in a navigation structure with a language code
 */
function prefixPagesWithLang(
  pages: (string | NavGroup)[],
  lang: string
): (string | NavGroup)[] {
  return pages.map((page) => {
    if (typeof page === "string") {
      return `${lang}/${page}`;
    }
    // Nested group
    return {
      ...page,
      pages: prefixPagesWithLang(page.pages, lang),
    };
  });
}

/**
 * Creates a language-specific navigation tab
 */
function createLangTab(tab: NavTab, lang: string): NavTab {
  return {
    ...tab,
    groups: tab.groups.map((group) => ({
      ...group,
      pages: prefixPagesWithLang(group.pages, lang),
    })),
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

function main(): void {
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

  // Add each available language
  for (const lang of availableLangs) {
    languages.push({
      language: lang,
      tabs: englishTabs.map((tab) => createLangTab(tab, lang)),
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

main();
