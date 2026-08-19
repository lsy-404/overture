<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { localized } from "../../lib/recipe/types";
import { sourceSlug } from "../../../shared/package";
import { WinButton, WinInfoBar } from "../../vendor/winui";

const { t, locale } = useI18n();
const wizard = useWizard();

const CONFIRM_LOCK_SECONDS = 3;
const lockSecondsLeft = ref(CONFIRM_LOCK_SECONDS);
let lockTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  lockTimer = setInterval(() => {
    lockSecondsLeft.value -= 1;
    if (lockSecondsLeft.value <= 0) clearInterval(lockTimer);
  }, 1000);
});
onUnmounted(() => clearInterval(lockTimer));

const recipe = computed(() => wizard.recipe);
const capabilities = computed(() => recipe.value?.capabilities ?? []);
/** The full report was shown when the package was picked; only what bites repeats here. */
const alerts = computed(() => (wizard.analysis?.findings ?? []).filter((finding) => finding.severity !== "note"));
const hostSecrets = computed(() => recipe.value?.hostSecrets ?? []);
/** The credentials the app itself will end up holding, stated plainly. */
const handsOverCredentials = computed(() => hostSecrets.value.some((secret) => secret.source !== "accountId"));

const resourceSummary = computed(() =>
  (recipe.value?.resources ?? [])
    .map((resource) => wizard.resourceNames[resource.id])
    .filter((name) => !!name)
    .join(", "),
);

function start() {
  wizard.resetExecution();
  wizard.goTo(STEPS.deploy);
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("confirm.title") }}</h1>
    <p class="step-subtitle">{{ t("confirm.subtitle") }}</p>

    <dl class="kv-list">
      <div class="kv-row">
        <dt>{{ t("confirm.sourceLabel") }}</dt>
        <dd>{{ wizard.source ? sourceSlug(wizard.source) : "" }}</dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("confirm.releaseLabel") }}</dt>
        <dd>{{ wizard.selectedTag }} · {{ recipe?.version }}</dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("confirm.modeLabel") }}</dt>
        <dd>
          {{ wizard.mode === "fresh" ? t("confirm.modeFresh") : t("confirm.modeOverwrite") }}
          <template v-if="wizard.mode === 'overwrite' && wizard.fullRebuild"> — {{ t("confirm.fullRebuild") }}</template>
        </dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("confirm.workerLabel") }}</dt>
        <dd>{{ wizard.workerName }}</dd>
      </div>
      <div v-if="resourceSummary" class="kv-row">
        <dt>{{ t("confirm.resourcesLabel") }}</dt>
        <dd>{{ resourceSummary }}</dd>
      </div>
      <div v-if="(recipe?.worker.containers || []).length > 0" class="kv-row">
        <dt>{{ t("confirm.containersLabel") }}</dt>
        <dd>{{ wizard.declareContainers.join(", ") || t("confirm.containersNone") }}</dd>
      </div>
      <div v-if="wizard.domainValue" class="kv-row">
        <dt>{{ t("confirm.domainLabel") }}</dt>
        <dd>{{ wizard.domainValue }}</dd>
      </div>
    </dl>

    <template v-if="wizard.activeInputs.length > 0">
      <h3 class="section-heading">{{ t("confirm.optionsTitle") }}</h3>
      <dl class="kv-list">
        <div v-for="input in wizard.activeInputs" :key="input.id" class="kv-row">
          <dt>{{ localized(input.label, locale) }}</dt>
          <dd>
            <code v-if="input.kind === 'password'">••••••••</code>
            <template v-else-if="input.kind === 'toggle'">{{ wizard.inputs[input.id] ? t("common.on") : t("common.off") }}</template>
            <template v-else>{{ (wizard.inputs[input.id] || t("confirm.emptyValue")).toString() }}</template>
          </dd>
        </div>
      </dl>
    </template>

    <template v-if="alerts.length > 0">
      <h3 class="section-heading">{{ t("confirm.alertsTitle") }}</h3>
      <WinInfoBar
        :IsOpen="true"
        :Severity="alerts.some((finding) => finding.severity === 'critical') ? 'Error' : 'Warning'"
        :IsClosable="false"
        :IsIconVisible="false"
      >
        <strong>{{ t("confirm.alertsIntro") }}</strong>
        <ul style="margin: 8px 0 0; padding-left: 20px">
          <li v-for="(finding, index) in alerts" :key="`${finding.code}-${index}`">
            {{ t(`analyze.findings.${finding.code}`, finding.values || {}) }}
          </li>
        </ul>
      </WinInfoBar>
    </template>

    <h3 class="section-heading">{{ t("confirm.capabilitiesTitle") }}</h3>
    <p class="field-help" style="margin-top: 0">{{ t("confirm.capabilitiesIntro", { app: recipe?.name || "" }) }}</p>
    <ul class="plain-list">
      <li v-for="capability in capabilities" :key="capability">
        <strong>{{ capability }}</strong> — {{ t(`confirm.capabilities.${capability}`) }}
      </li>
      <li v-if="capabilities.length === 0">{{ t("confirm.capabilitiesNone") }}</li>
    </ul>

    <template v-if="hostSecrets.length > 0">
      <h3 class="section-heading">{{ t("confirm.hostSecretsTitle") }}</h3>
      <WinInfoBar
        v-if="handsOverCredentials"
        :IsOpen="true"
        Severity="Warning"
        :IsClosable="false"
        :IsIconVisible="false"
      >
        <strong>{{ t("confirm.hostSecretsWarnTitle") }}</strong>
        <p style="margin: 6px 0 0">{{ t("confirm.hostSecretsWarnBody") }}</p>
      </WinInfoBar>
      <ul class="plain-list">
        <li v-for="secret in hostSecrets" :key="secret.name">
          <code>{{ secret.name }}</code> — {{ t(`confirm.secretSources.${secret.source}`) }}
          <span :class="`requirement-${secret.requirement}`">({{ t(`credentials.requirements.${secret.requirement}`) }})</span>
          — {{ localized(secret.reason, locale) }}
        </li>
      </ul>
    </template>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="wizard.goTo(STEPS.target)">{{ t("common.back") }}</WinButton>
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="lockSecondsLeft <= 0" @Click="start">
          {{ lockSecondsLeft > 0 ? t("confirm.confirmWait", { seconds: lockSecondsLeft }) : t("confirm.confirm") }}
        </WinButton>
      </div>
    </Teleport>
  </div>
</template>
