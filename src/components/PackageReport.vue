<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { PackageAnalysis, Severity } from "../lib/analyze/analyze";
import { dashboardLabel } from "../lib/analyze/permissions";
import { WinInfoBar } from "../vendor/winui";

const props = defineProps<{ analysis: PackageAnalysis }>();
const { t } = useI18n();

const SEVERITY_BARS: Record<Severity, string> = {
  critical: "Error",
  warning: "Warning",
  note: "Informational",
};

const barSeverity = computed(() => (props.analysis.worst ? SEVERITY_BARS[props.analysis.worst] : "Success"));

/** "Overture itself" reads better than the reserved id it is stored under. */
function viaLabel(via: string): string {
  return via === "host" ? t("analyze.viaHost") : via;
}

function alternatives(groups: string[]): string {
  return groups.join(t("analyze.orSeparator"));
}

function dashboardHint(groups: string[]): string {
  return groups.map(dashboardLabel).join(t("analyze.orSeparator"));
}
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
        {{ t(`analyze.findings.${finding.code}`, finding.values || {}) }}
      </li>
    </ul>

    <h4>{{ t("analyze.permissionsTitle") }}</h4>
    <p class="field-help" style="margin-top: 0">{{ t("analyze.permissionsIntro") }}</p>
    <ul class="plain-list">
      <li v-for="need in analysis.permissions" :key="need.groups.join('|')">
        <code>{{ alternatives(need.groups) }}</code>
        <span class="field-help"> — {{ t("analyze.permissionDashboard", { labels: dashboardHint(need.groups) }) }}</span>
        <p v-if="need.uncertain" class="field-help tone-warn" style="margin: 4px 0 0">
          {{ t(`analyze.uncertain.${need.uncertain}`) }}
        </p>
      </li>
      <li v-if="analysis.permissions.length === 0">{{ t("analyze.permissionsNone") }}</li>
    </ul>

    <details class="report-details">
      <summary>{{ t("analyze.endpointsTitle", { count: analysis.endpoints.length }) }}</summary>
      <ul class="plain-list">
        <li v-for="endpoint in analysis.endpoints" :key="endpoint.id">
          <code>{{ endpoint.method }} {{ endpoint.path }}</code>
          <span class="field-help"> — {{ endpoint.via.map(viaLabel).join(", ") }}</span>
        </li>
      </ul>
    </details>

    <template v-if="analysis.checks.length > 0">
      <h4>{{ t("analyze.checksTitle") }}</h4>
      <ul class="plain-list">
        <li v-for="check in analysis.checks" :key="check.id">
          <code>{{ check.path }}</code>
          <span :class="`requirement-${check.requirement}`">({{ t(`credentials.requirements.${check.requirement}`) }})</span>
          <span v-if="check.malformed" class="field-help tone-bad"> — {{ t("analyze.checkMalformed") }}</span>
          <span v-else-if="!check.endpoint" class="field-help tone-bad"> — {{ t("analyze.checkUnknown") }}</span>
          <span v-else class="field-help tone-ok"> — {{ t("analyze.checkKnown") }}</span>
        </li>
      </ul>
    </template>

    <h4>{{ t("analyze.networkTitle") }}</h4>
    <p class="field-help" style="margin-top: 0">{{ t("analyze.networkIntro") }}</p>
    <ul class="plain-list">
      <li v-for="target in analysis.network" :key="`${target.via}-${target.origin}`">
        <code>{{ target.origin }}</code>
        <span class="field-help"> — {{ t("analyze.networkVia", { via: target.via }) }}</span>
        <span v-if="target.partial" class="field-help tone-warn"> {{ t("analyze.networkPartial") }}</span>
      </li>
      <li v-if="analysis.network.length === 0 && analysis.script.opaqueNetwork === 0">{{ t("analyze.networkNone") }}</li>
      <li v-if="analysis.script.opaqueNetwork > 0" class="tone-warn">
        {{ t("analyze.networkOpaque", { count: analysis.script.opaqueNetwork }) }}
      </li>
    </ul>
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

.report-details {
  margin-top: 18px;
}

.report-details summary {
  cursor: pointer;
}
</style>
