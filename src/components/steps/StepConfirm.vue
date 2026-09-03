<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { localized } from "../../lib/recipe/types";
import { sourceSlug } from "../../../shared/package";
import { WinButton, WinInfoBar } from "../../vendor/winui";
import { SHELL_SCROLL_AREA } from "../shellScroll";

const { t, locale } = useI18n();
const wizard = useWizard();

const CONFIRM_LOCK_SECONDS = 3;
const lockSecondsLeft = ref(CONFIRM_LOCK_SECONDS);
let lockTimer: ReturnType<typeof setInterval> | undefined;
const shellScrollArea = inject(SHELL_SCROLL_AREA);
const hasViewedEnd = ref(false);
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;

function checkViewedEnd() {
  const element = shellScrollArea?.value;
  if (!element) {
    hasViewedEnd.value = false;
    return;
  }
  const maxScrollTop = element.scrollHeight - element.clientHeight;
  hasViewedEnd.value = maxScrollTop <= 1 || element.scrollTop >= maxScrollTop - 1;
}

function refreshViewedEnd() {
  void nextTick(checkViewedEnd);
}

onMounted(() => {
  lockTimer = setInterval(() => {
    lockSecondsLeft.value -= 1;
    if (lockSecondsLeft.value <= 0) clearInterval(lockTimer);
  }, 1000);
  const element = shellScrollArea?.value;
  if (element) {
    element.addEventListener("scroll", checkViewedEnd, { passive: true });
    resizeObserver = new ResizeObserver(checkViewedEnd);
    resizeObserver.observe(element);
    mutationObserver = new MutationObserver(refreshViewedEnd);
    mutationObserver.observe(element, { childList: true, subtree: true, characterData: true });
  }
  refreshViewedEnd();
});
onUnmounted(() => {
  clearInterval(lockTimer);
  const element = shellScrollArea?.value;
  element?.removeEventListener("scroll", checkViewedEnd);
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
});

const recipe = computed(() => wizard.recipe);
const capabilities = computed(() => recipe.value?.capabilities ?? []);
/** The full report was shown when the package was picked; only what bites repeats here. */
const alerts = computed(() => (wizard.analysis?.findings ?? []).filter((finding) => finding.severity !== "note"));
const hostSecrets = computed(() => recipe.value?.hostSecrets ?? []);
// The Turnstile contract is supplied by the recipe schema; keep this UI usable
// while older packages without the optional field are still loaded.
const turnstiles = computed(() => (recipe.value as unknown as { turnstiles?: Array<{
  id: string;
  name: string;
  domains: string[];
  mode: string;
  secret: { target: "recipe" } | { target: "workerSecret"; name: string };
}> } | null)?.turnstiles ?? []);
const turnstileRecipeSecret = computed(() => turnstiles.value.some((widget) => widget.secret.target === "recipe"));
/** The credentials the app itself will end up holding, stated plainly. */
const handsOverCredentials = computed(() => hostSecrets.value.some((secret) => secret.source !== "accountId"));

watch([recipe, capabilities, alerts, hostSecrets, turnstiles, () => wizard.activeInputs, () => wizard.domainValue], refreshViewedEnd, {
  deep: true,
  flush: "post",
});

/**
 * The one line a hijacked or stale session would show wrong — the account
 * name only Cloudflare's own consent screen otherwise displayed. Also the gate
 * for the confirm button itself: a session granted for a different package
 * (picked, went back, picked another) may not stand in for consent to this one.
 */
const accountName = computed(() => wizard.oauthAccounts.find((account) => account.id === wizard.credentials.accountId)?.name || "");
const sessionOk = computed(() => wizard.sessionMatchesPackage && !!wizard.credentials.accountId);

/** The names this deployment will really use — an adopted resource keeps its own. */
const resourceSummary = computed(() =>
  (recipe.value?.resources ?? [])
    .map((resource) => wizard.effectiveResourceNames[resource.id])
    .filter((name) => !!name)
    .join(", "),
);

/** Existing resources this deployment writes into rather than creates. */
const adoptedSummary = computed(() =>
  (recipe.value?.resources ?? [])
    .map((resource) => wizard.adoptions[resource.id]?.name)
    .filter((name): name is string => !!name)
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

    <WinInfoBar v-if="!sessionOk" :IsOpen="true" Severity="Error" :IsClosable="false" :IsIconVisible="false">
      {{ t("confirm.sessionStale") }}
    </WinInfoBar>

    <dl class="kv-list">
      <div class="kv-row">
        <dt>{{ t("confirm.accountLabel") }}</dt>
        <dd>{{ accountName }} <span class="field-help">({{ wizard.credentials.accountId }})</span></dd>
      </div>
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
      <div v-if="adoptedSummary" class="kv-row">
        <dt>{{ t("confirm.adoptedLabel") }}</dt>
        <dd class="tone-warn">{{ adoptedSummary }}</dd>
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
          <span :class="`requirement-${secret.requirement}`">({{ t(`authorize.requirements.${secret.requirement}`) }})</span>
          — {{ localized(secret.reason, locale) }}
        </li>
      </ul>
    </template>

    <template v-if="turnstiles.length > 0">
      <h3 class="section-heading">{{ t("confirm.turnstilesTitle") }}</h3>
      <WinInfoBar
        v-if="turnstileRecipeSecret"
        :IsOpen="true"
        Severity="Error"
        :IsClosable="false"
        :IsIconVisible="false"
      >
        <strong>{{ t("confirm.turnstileRecipeWarningTitle") }}</strong>
        <p style="margin: 6px 0 0">{{ t("confirm.turnstileRecipeWarningBody") }}</p>
      </WinInfoBar>
      <ul class="plain-list">
        <li v-for="widget in turnstiles" :key="widget.id">
          <strong>{{ widget.name }}</strong> — {{ t("confirm.turnstileMode", { mode: widget.mode }) }}
          <span v-if="widget.domains.length > 0"> · {{ t("confirm.turnstileDomains", { domains: widget.domains.join(", ") }) }}</span>
          <p class="field-help" style="margin: 2px 0 0">{{ t("confirm.turnstileSiteKey") }}</p>
          <p v-if="widget.secret.target === 'recipe'" class="field-help tone-bad">{{ t("confirm.turnstileSecretRecipe") }}</p>
          <p v-else class="field-help">{{ t("confirm.turnstileSecretWorker", { name: widget.secret.name }) }}</p>
        </li>
      </ul>
    </template>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="wizard.goTo(STEPS.target)">{{ t("common.back") }}</WinButton>
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="lockSecondsLeft <= 0 && sessionOk && hasViewedEnd" @Click="start">
          {{ lockSecondsLeft > 0 ? t("confirm.confirmWait", { seconds: lockSecondsLeft }) : t("confirm.confirm") }}
        </WinButton>
      </div>
      <p v-if="!hasViewedEnd" class="field-help accept-hint">{{ t("confirm.scrollToEnd") }}</p>
    </Teleport>
  </div>
</template>
