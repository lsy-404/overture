<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import type { AuthMode } from "../../lib/recipe/types";
import { WinButton } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();

// Fixed display order; only the modes this recipe actually declared appear.
const ORDER: AuthMode[] = ["oauth", "auto", "manual"];
const modes = computed(() => ORDER.filter((mode) => (wizard.recipe?.authModes ?? []).includes(mode)));

function choose(mode: AuthMode) {
  wizard.setAuthMode(mode);
  wizard.goTo(STEPS.authorize);
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("authMethod.title") }}</h1>
    <p class="step-subtitle">{{ t("authMethod.subtitle") }}</p>

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
