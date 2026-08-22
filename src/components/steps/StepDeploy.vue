<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref, toRaw } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { runRecipe } from "../../lib/engine/run";
import { DeployError, HOST_STEP_HEALTH } from "../../lib/deploy/types";
import { localized } from "../../lib/recipe/types";
import { issueReport, issueUrl } from "../../lib/recipe/issueReport";
import { WinButton, WinInfoBar, WinProgressBar, WinProgressRing } from "../../vendor/winui";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const { t, locale } = useI18n();
const wizard = useWizard();

const running = ref(false);
const copiedReport = ref(false);

const report = computed(() => {
  const recipe = wizard.recipe;
  return recipe ? issueReport(recipe, wizard.failedStep) : "";
});
const reportUrl = computed(() => {
  const recipe = wizard.recipe;
  return recipe ? issueUrl(recipe, wizard.failedStep) : "";
});

async function copyReport() {
  try {
    await navigator.clipboard.writeText(report.value);
    copiedReport.value = true;
    setTimeout(() => (copiedReport.value = false), 1500);
  } catch {
    // Clipboard access is a convenience; the issue link contains the same report.
  }
}

// Host-owned lines are named by Overture; everything else is a recipe step and
// carries its own localised label.
function labelFor(id: string): string {
  if (id === HOST_STEP_HEALTH) return t("deploy.hostSteps.health");
  const step = (wizard.recipe?.steps ?? []).find((entry) => entry.id === id);
  return step ? localized(step.label, locale.value) : id;
}

async function start() {
  const config = wizard.config;
  const dataPackage = wizard.dataPackage;
  if (!config || !dataPackage) {
    wizard.deployFailed = true;
    wizard.failedMessage = t("deploy.configMissing");
    return;
  }
  wizard.resetExecution();
  running.value = true;
  try {
    // Auto mode's app token is whatever the user pasted on the authorize step
    // — already in `credentials` by the time the recipe's declared host
    // secrets get pushed, the same channel the R2 keys use. Nothing here mints
    // or deletes it: it is the user's own token.
    const result = await runRecipe({
      config,
      dataPackage: toRaw(dataPackage),
      creds: { ...wizard.credentials },
      target: wizard.buildTarget(),
      live: toRaw(wizard.live),
      locale: locale.value,
      onStep: (id, status, detail) => wizard.setStepStatus(id, status, detail),
      onProgress: (id, fraction) => wizard.setStepProgress(id, fraction),
    });
    wizard.result = result;

    await delay(1200);
    wizard.goTo(STEPS.done);
  } catch (e) {
    if (e instanceof DeployError && e.step) wizard.failedStep = e.step;
    wizard.failedMessage = e instanceof Error ? e.message : String(e);
    wizard.deployFailed = true;
    wizard.finishFailure();
  } finally {
    running.value = false;
  }
}

onMounted(() => void start());

function retry() {
  void start();
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("deploy.title") }}</h1>
    <p class="step-subtitle">{{ t("deploy.subtitle") }}</p>

    <dl class="execute-steps">
      <div v-for="state in wizard.stepStates" :key="state.id" class="kv-row execute-step-row">
        <dt class="execute-step-label">
          <!-- MinWidth/MinHeight default to 16 and clamp Width/Height, so both
               have to be set for the ring to match the dot it replaces. -->
          <WinProgressRing v-if="state.status === 'running'" :Width="10" :Height="10" :MinWidth="10" :MinHeight="10" />
          <span v-else class="status-dot" :class="`status-dot-${state.status}`" />
          {{ labelFor(state.id) }}
        </dt>
        <dd>
          <template v-if="state.status === 'running' && state.progress !== undefined">
            {{ Math.round(state.progress * 100) }}%
          </template>
          <template v-else>{{ t(`deploy.status.${state.status}`) }}</template>
          <p v-if="state.detail && state.status === 'failed'" class="field-help" style="margin: 4px 0 0">{{ state.detail }}</p>
        </dd>
        <WinProgressBar
          v-if="state.status === 'running' && state.progress !== undefined"
          :Value="state.progress * 100"
          class="execute-step-progress"
        />
      </div>
    </dl>

    <WinInfoBar v-if="wizard.deployFailed" :IsOpen="true" Severity="Error" :IsClosable="false" :IsIconVisible="false" style="margin-top: 20px">
      <strong>{{ t("deploy.failedTitle") }}</strong>
      <p v-if="wizard.failedStep" style="margin: 6px 0 0">{{ t("deploy.failedAt", { step: labelFor(wizard.failedStep) }) }}</p>
      <p style="margin: 6px 0 0">{{ wizard.failedMessage }}</p>
    </WinInfoBar>

    <p v-if="wizard.deployFailed" class="field-help">{{ t("deploy.retryFromHere") }}</p>

    <div v-if="wizard.deployFailed && reportUrl" class="link-row">
      <WinButton @Click="copyReport">{{ copiedReport ? t("common.copied") : t("deploy.copyReport") }}</WinButton>
      <a :href="reportUrl" target="_blank" rel="noopener noreferrer" class="btn">{{ t("deploy.reportIssue") }} ↗</a>
    </div>

    <Teleport defer to=".shell-card-actions">
      <div v-if="wizard.deployFailed && !running" class="step-actions">
        <WinButton @Click="wizard.goTo(STEPS.confirm)">{{ t("common.back") }}</WinButton>
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" @Click="retry">{{ t("common.retry") }}</WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.link-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
</style>
