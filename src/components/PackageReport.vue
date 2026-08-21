<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { PackageAnalysis, Severity } from "../lib/analyze/analyze";
import { WinInfoBar } from "../vendor/winui";

const props = defineProps<{ analysis: PackageAnalysis }>();
const { t } = useI18n();

const SEVERITY_BARS: Record<Severity, string> = {
  critical: "Error",
  warning: "Warning",
  note: "Informational",
};

const barSeverity = computed(() => (props.analysis.worst ? SEVERITY_BARS[props.analysis.worst] : "Success"));

// Findings that name a credential source carry the raw internal id (e.g.
// "cfApiToken"); swap it for the human name before it reaches the sentence.
function findingText(code: string, values?: Record<string, string>): string {
  if (values && values.source) {
    return t(`analyze.findings.${code}`, { ...values, source: t(`analyze.sourceName.${values.source}`) });
  }
  return t(`analyze.findings.${code}`, values || {});
}

const hasEgress = computed(() => props.analysis.network.length > 0 || props.analysis.script.opaqueNetwork > 0);
</script>

<template>
  <div class="package-report">
    <h3 class="section-heading">{{ t("analyze.title") }}</h3>

    <WinInfoBar :IsOpen="true" :Severity="barSeverity" :IsClosable="false" :IsIconVisible="false">
      <strong>{{ analysis.worst ? t("analyze.summaryFindings") : t("analyze.summaryClean") }}</strong>
      <p style="margin: 6px 0 0">{{ analysis.certain ? t("analyze.certain") : t("analyze.uncertainScan") }}</p>
    </WinInfoBar>

    <ul v-if="analysis.findings.length > 0" class="plain-list finding-list">
      <li v-for="(finding, index) in analysis.findings" :key="`${finding.code}-${index}`">
        <span class="field-tag" :class="`severity-${finding.severity}`">{{ t(`analyze.severity.${finding.severity}`) }}</span>
        {{ findingText(finding.code, finding.values) }}
      </li>
    </ul>

    <template v-if="hasEgress">
      <h4>{{ t("analyze.networkTitle") }}</h4>
      <p class="field-help" style="margin-top: 0">{{ t("analyze.networkIntro") }}</p>
      <ul class="plain-list">
        <li v-for="target in analysis.network" :key="`${target.via}-${target.origin}`">
          <code>{{ target.origin }}</code>
          <span v-if="target.partial" class="field-help tone-warn"> {{ t("analyze.networkPartial") }}</span>
        </li>
        <li v-if="analysis.script.opaqueNetwork > 0" class="tone-warn">
          {{ t("analyze.networkOpaque", { count: analysis.script.opaqueNetwork }) }}
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.package-report h4 {
  margin-top: 20px;
}

.finding-list {
  margin-top: 14px;
}

.severity-critical {
  background: color-mix(in srgb, var(--SystemFillColorCriticalBrush) 16%, transparent);
  color: var(--SystemFillColorCriticalBrush);
}

.severity-warning {
  background: color-mix(in srgb, var(--SystemFillColorCautionBrush) 16%, transparent);
  color: var(--SystemFillColorCautionBrush);
}

.severity-note {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
</style>
