#!/usr/bin/env npx ts-node
/**
 * Batch-sanitizes frontmatter for all locale MDX files (fixes YAML apostrophe bugs).
 * Run after pulling prod or before deploy. Idempotent for already-clean files.
 *
 * Usage: npx ts-node scripts/sanitize-locale-frontmatter.ts [--validate-only]
 *
 * @module sanitize-locale-frontmatter
 */

import * as fs from "fs";
import * as path from "path";
import { sanitizeMdxFrontmatter, validateSanitizedMdx } from "./mdx-frontmatter-sanitize";

const DOCS_ROOT = path.resolve(__dirname, "..");
const LANGS = ["de", "fr", "es", "nl", "zh", "it", "ja"];

function walkMdx(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      walkMdx(p, out);
    } else if (name.endsWith(".mdx")) {
      out.push(p);
    }
  }
}

async function main(): Promise<void> {
  const validateOnly = process.argv.includes("--validate-only");
  let changed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const lang of LANGS) {
    const root = path.join(DOCS_ROOT, lang);
    const files: string[] = [];
    walkMdx(root, files);
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      const v = validateSanitizedMdx(raw);
      if (!v.ok && !raw.match(/^---\r?\n/)) {
        continue;
      }
      if (validateOnly) {
        if (!v.ok) {
          failed++;
          errors.push(`${path.relative(DOCS_ROOT, file)}: ${v.error}`);
        }
        continue;
      }
      const r = sanitizeMdxFrontmatter(raw);
      if (!r.ok) {
        failed++;
        errors.push(`${path.relative(DOCS_ROOT, file)}: ${r.error}`);
        continue;
      }
      if (r.content !== raw) {
        fs.writeFileSync(file, r.content, "utf8");
        changed++;
      }
    }
  }

  console.log(
    validateOnly
      ? `Validate-only: ${failed} failed, ${errors.length ? errors.slice(0, 15).join("\n") : "all ok"}`
      : `Sanitized: ${changed} files updated, ${failed} parse failures`
  );
  if (errors.length > 0 && !validateOnly) {
    console.log(errors.slice(0, 20).join("\n"));
  }
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
