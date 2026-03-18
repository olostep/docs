#!/usr/bin/env npx ts-node
/**
 * Updates docs.json to include language configurations for i18n.
 *
 * CRITICAL: This generates `navigation.languages[].tabs` (NOT `groups`).
 * This preserves the exact tab structure for each language.
 *
 * @see engineering-docs/architecture/MINTLIFY-I18N-TABS-WORKING.md
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

interface LanguageNavConfig {
  language: string;
  default?: boolean;
  tabs: NavTab[];
}

interface DocsConfig {
  navigation: {
    tabs?: NavTab[];
    languages?: LanguageNavConfig[];
    global?: Record<string, unknown>;
  };
  openapi?: string[];
  [key: string]: unknown;
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

// Defer OpenAI client creation - only initialize if API key is present
let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openai && process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai!;
}

const translationCache: Map<string, Map<string, string>> = new Map();

/**
 * Checks if a language has any translated files
 */
function hasTranslations(lang: string): boolean {
  const langDir = path.join(DOCS_ROOT, lang);
  if (!fs.existsSync(langDir)) {
    return false;
  }

  const files = fs.readdirSync(langDir, { recursive: true });
  return files.some((f) => f.toString().endsWith(".mdx"));
}

/**
 * Translates a navigation label to the target language.
 * If OPENAI_API_KEY is not set, returns the original label (for testing).
 */
async function translateLabel(label: string, lang: string): Promise<string> {
  // Skip translation if no API key (for local testing)
  if (!process.env.OPENAI_API_KEY) {
    return label;
  }

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
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o",
      temperature: 0.1,
      max_tokens: 50,
      messages: [
        {
          role: "system",
          content: `Translate this UI navigation label to ${langInfo.name} (${langInfo.nativeName}). Output ONLY the translated text, no quotes or explanation.`,
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
    console.warn(`  Warning: Failed to translate label "${label}" to ${lang}`);
    return label;
  }
}

/**
 * Recursively prefixes page paths with language code and translates group names.
 */
async function translateGroup(group: NavGroup, lang: string): Promise<NavGroup> {
  const translatedGroup = await translateLabel(group.group, lang);

  const translatedPages: (string | NavGroup)[] = [];
  for (const page of group.pages) {
    if (typeof page === "string") {
      translatedPages.push(`${lang}/${page}`);
    } else {
      translatedPages.push(await translateGroup(page, lang));
    }
  }

  return {
    ...group,
    group: translatedGroup,
    pages: translatedPages,
  };
}

/**
 * Translates a full tab (tab name + all groups inside)
 */
async function translateTab(tab: NavTab, lang: string): Promise<NavTab> {
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
 * Creates language config entry with full tabs array (NOT groups)
 */
async function createLanguageConfig(
  englishTabs: NavTab[],
  lang: string
): Promise<LanguageNavConfig> {
  const translatedTabs: NavTab[] = [];

  for (const tab of englishTabs) {
    translatedTabs.push(await translateTab(tab, lang));
  }

  return {
    language: lang,
    tabs: translatedTabs,
  };
}

async function main(): Promise<void> {
  console.log("Updating docs.json with i18n language configurations...\n");

  const configContent = fs.readFileSync(DOCS_CONFIG_PATH, "utf8");
  const config: DocsConfig = JSON.parse(configContent);

  const availableLangs = Object.keys(LANGUAGES).filter(hasTranslations);
  console.log(`Languages with translations: ${availableLangs.join(", ") || "none"}`);

  if (availableLangs.length === 0) {
    console.log("No translations found, keeping original config");
    return;
  }

  // # Note: After a deploy, docs.json only has languages[]; re-runs need en tabs from there.
  let englishTabs = config.navigation.tabs;
  if (!englishTabs?.length && Array.isArray(config.navigation.languages)) {
    const en = config.navigation.languages.find((l) => (l as LanguageNavConfig).language === "en");
    if (en && (en as LanguageNavConfig).tabs?.length) {
      englishTabs = (en as LanguageNavConfig).tabs;
    }
  }
  if (!englishTabs?.length) {
    console.error("No English tabs found in navigation (tabs or languages[en])");
    process.exit(1);
  }

  console.log(`English tabs: ${englishTabs.map((t) => t.tab).join(", ")}`);

  // Build languages array with TABS (not groups!)
  const languages: LanguageNavConfig[] = [
    {
      language: "en",
      default: true,
      tabs: englishTabs,
    },
  ];

  console.log("\nTranslating navigation labels for each language...");
  for (const lang of availableLangs) {
    console.log(`  ${lang}: translating tabs and groups...`);
    const langConfig = await createLanguageConfig(englishTabs, lang);
    languages.push(langConfig);
  }

  // Preserve global config (anchors, etc.)
  const global = config.navigation.global;

  // Build new config - remove tabs at top level, add languages
  const newConfig: DocsConfig = {
    ...config,
    navigation: {
      languages,
      ...(global ? { global } : {}),
    },
  };

  // Remove the top-level tabs since they're now inside languages
  delete (newConfig.navigation as { tabs?: NavTab[] }).tabs;

  fs.writeFileSync(DOCS_CONFIG_PATH, JSON.stringify(newConfig, null, 2), "utf8");

  console.log("\n✓ docs.json updated with i18n configuration");
  console.log(`  Languages: ${languages.map((l) => l.language).join(", ")}`);
  console.log(`  Structure: navigation.languages[].tabs (preserves tab structure)`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
