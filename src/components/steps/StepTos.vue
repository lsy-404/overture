<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { WinButton, WinCheckBox } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();

const SECTIONS = ["auth", "privacy", "ownership", "liability", "capabilities", "license"] as const;
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("tos.title") }}</h1>
    <p class="step-subtitle">{{ t("tos.subtitle") }}</p>

    <div class="guide-card disclaimer-body">
      <section v-for="(section, index) in SECTIONS" :key="section" class="disclaimer-section">
        <div class="section-rule" v-if="index > 0" aria-hidden="true" />
        <h2 class="section-heading">{{ t(`tos.sections.${section}.heading`) }}</h2>
        <p class="section-body">{{ t(`tos.sections.${section}.body`) }}</p>
      </section>
    </div>

    <div class="accept-row">
      <WinCheckBox v-model="wizard.tosAccepted">
        <span><span class="required-star" aria-hidden="true">*</span>{{ t("tos.accept") }}</span>
      </WinCheckBox>
    </div>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="wizard.tosAccepted" @Click="wizard.goTo(STEPS.repository)">
          {{ t("common.next") }}
        </WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.disclaimer-body {
  display: flex;
  flex-direction: column;
}

.disclaimer-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.section-rule {
  height: 1px;
  background: var(--card-stroke);
  margin: 12px 0;
}

.section-heading {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
}

.section-body {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.6;
  color: var(--text-primary);
}

.accept-row {
  margin-top: 20px;
}
</style>
