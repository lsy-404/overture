<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { WinButton, WinCheckBox } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("tos.title") }}</h1>
    <p class="step-subtitle">{{ t("tos.subtitle") }}</p>

    <div class="guide-card">
      <ul class="notice-list">
        <li>{{ t("tos.point1") }}</li>
        <li>{{ t("tos.point2") }}</li>
        <li>{{ t("tos.point3") }}</li>
        <li>{{ t("tos.point4") }}</li>
        <li>{{ t("tos.point5") }}</li>
        <li>{{ t("tos.point6") }}</li>
        <li>{{ t("tos.point7") }}</li>
      </ul>
    </div>

    <div class="accept-row">
      <WinCheckBox v-model="wizard.tosAccepted">
        <span><span class="required-star" aria-hidden="true">*</span>{{ t("tos.accept") }}</span>
      </WinCheckBox>
    </div>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="wizard.tosAccepted" @Click="wizard.goTo(STEPS.version)">
          {{ t("common.next") }}
        </WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.notice-list {
  margin: 0;
  padding-left: 20px;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.notice-list li + li {
  margin-top: 8px;
}

.accept-row {
  margin-top: 20px;
}
</style>
