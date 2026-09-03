// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("Turnstile disclosure contract", () => {
  it("documents both secret delivery targets", () => {
    const recipe = read("docs/RECIPE.md");
    expect(recipe).toContain('"turnstiles"');
    expect(recipe).toContain('"target": "recipe"');
    expect(recipe).toContain('"target": "workerSecret"');
    expect(recipe).toContain('"name": "TURNSTILE_SECRET"');
  });

  it("confirmation UI discloses widget configuration and secret destination", () => {
    const confirm = read("src/components/steps/StepConfirm.vue");
    expect(confirm).toContain("turnstiles");
    expect(confirm).toContain("turnstileRecipeWarning");
    expect(confirm).toContain("turnstileSecretWorker");
    expect(confirm).toContain("widget.secret.target === 'recipe'");
    expect(confirm).toContain("widget.secret.name");
  });

  it("adds Turnstile permission to auto-token creation", () => {
    const authorize = read("src/components/steps/StepAuthorize.vue");
    expect(authorize).toContain('key: "challenge_widgets"');
    expect(authorize).toContain('type: "edit"');
    expect(authorize).toContain("turnstiles");
  });

  it("keeps the high-risk warning in both locales and public docs", () => {
    const en = read("src/locales/en.json");
    const zh = read("src/locales/zh-CN.json");
    expect(en).toContain("turnstileRecipeWarningBody");
    expect(zh).toContain("turnstileRecipeWarningBody");
    expect(read("README.md")).toContain("turnstiles[]");
    expect(read("README.zh-CN.md")).toContain("turnstiles[]");
    expect(read("CONTRACT.md")).toContain("Turnstile delivery");
  });
});
