<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { usePolicy } from "../stores/policy";
import { WinButton, WinInfoBar, WinProgressRing } from "../vendor/winui";

const { t } = useI18n();
const policy = usePolicy();

onMounted(() => {
  if (!policy.loaded) void policy.load();
});
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("policy.title") }}</h1>
    <p class="step-subtitle">{{ t("policy.subtitle") }}</p>

    <div v-if="!policy.loaded" class="inline-status">
      <WinProgressRing :Width="20" :Height="20" :IsActive="true" />
      <span>{{ t("common.loading") }}</span>
    </div>

    <template v-else>
      <dl class="kv-list">
        <div class="kv-row">
          <dt>{{ t("policy.allowlistState") }}</dt>
          <dd>{{ policy.policy.allowlistEnabled ? t("policy.allowlistOn") : t("policy.allowlistOff") }}</dd>
        </div>
        <div class="kv-row">
          <dt>{{ t("policy.sourceCount") }}</dt>
          <dd>{{ policy.policy.sources.length }}</dd>
        </div>
      </dl>

      <WinInfoBar :IsOpen="true" Severity="Warning" :IsClosable="false" :IsIconVisible="false">
        <strong>{{ t("policy.riskTitle") }}</strong>
        <p style="margin: 6px 0 0">{{ t("policy.riskBody") }}</p>
      </WinInfoBar>

      <h3 class="section-heading">{{ t("policy.sourcesTitle") }}</h3>
      <ul class="plain-list">
        <li v-for="slug in policy.policy.sources" :key="slug"><code>{{ slug }}</code></li>
        <li v-if="policy.policy.sources.length === 0">{{ t("policy.noSources") }}</li>
      </ul>

      <p class="field-help" style="margin-top: 24px">{{ t("policy.readOnlyHint") }}</p>
    </template>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="policy.show('wizard')">{{ t("policy.backToWizard") }}</WinButton>
      </div>
    </Teleport>
  </div>
</template>
