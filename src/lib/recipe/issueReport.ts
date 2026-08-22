// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Recipe } from "./types";

/**
 * Builds the only failure report Overture shares outside the current tab.
 *
 * Deliberately do not accept the error message, credentials, target, or inputs
 * here. Deployment errors can echo request data, so a useful report has to be
 * an allowlist of package metadata and the declared checklist step instead.
 */
export function issueReport(recipe: Pick<Recipe, "id" | "version">, failedStep: string): string {
  return [
    "## Overture deployment failure",
    "",
    `- Package: ${recipe.id}`,
    `- Version: ${recipe.version}`,
    `- Step: ${failedStep || "not available"}`,
    "- Error summary: Deployment did not complete. Detailed error text is omitted to protect credentials and configuration.",
  ].join("\n");
}

/** Adds conventional issue title/body parameters while preserving tracker-specific query parameters. */
export function issueUrl(recipe: Pick<Recipe, "id" | "version" | "issues">, failedStep: string): string {
  const url = new URL(recipe.issues.url);
  url.searchParams.set("title", `Deployment failure: ${recipe.id} ${recipe.version}`);
  url.searchParams.set("body", issueReport(recipe, failedStep));
  return url.toString();
}
