<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import type { AuthMode } from "../../lib/recipe/types";
import { WinButton, WinInfoBar } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();

// Fixed display order; only modes both the recipe and this Overture instance
// actually support appear (wizard.availableAuthModes).
const ORDER: AuthMode[] = ["oauth", "auto"];
const modes = computed(() => ORDER.filter((mode) => wizard.availableAuthModes.includes(mode)));

// When the only reason nothing is offered is that OAuth would need scopes this
// site's client cannot grant, the block says so and names them, instead of the
// generic unavailable line.
const scopeShortfall = computed(() => wizard.oauthScopeShortfall);

function choose(mode: AuthMode) {
  wizard.setAuthMode(mode);
  wizard.goTo(STEPS.authorize);
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("authMethod.title") }}</h1>
    <p class="step-subtitle">{{ t("authMethod.subtitle") }}</p>

    <WinInfoBar v-if="wizard.noAuthModeAvailable" :IsOpen="true" Severity="Error" :IsClosable="false" :IsIconVisible="false">
      <strong>{{ t("authMethod.notAvailable.title") }}</strong>
      <p v-if="scopeShortfall.length" style="margin: 6px 0 0">{{ t("authMethod.notAvailable.scopeShortfall", { scopes: scopeShortfall.join(" ") }) }}</p>
      <p v-else style="margin: 6px 0 0">{{ t("authMethod.notAvailable.body") }}</p>
    </WinInfoBar>

    <button
      v-for="authMode in modes"
      :key="authMode"
      type="button"
      class="card-option"
      :class="{ selected: wizard.authMode === authMode }"
      @click="choose(authMode)"
    >
      <h3>{{ t(`authMethod.modes.${authMode}.title`) }}</h3>
      <p>{{ t(`authMethod.modes.${authMode}.description`) }}</p>
    </button>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="wizard.goTo(STEPS.license)">{{ t("common.back") }}</WinButton>
      </div>
    </Teleport>
  </div>
</template>
