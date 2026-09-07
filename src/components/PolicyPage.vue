<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { usePolicy } from "../stores/policy";
import { FluentButton, FluentNotice, FluentProgressRing } from "@lsypkg/fluent/vue";

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
      <FluentProgressRing :size="20" />
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

      <FluentNotice tone="warning">
        <strong>{{ t("policy.riskTitle") }}</strong>
        <p style="margin: 6px 0 0">{{ t("policy.riskBody") }}</p>
      </FluentNotice>

      <h3 class="section-heading">{{ t("policy.sourcesTitle") }}</h3>
      <ul class="plain-list">
        <li v-for="slug in policy.policy.sources" :key="slug"><code>{{ slug }}</code></li>
        <li v-if="policy.policy.sources.length === 0">{{ t("policy.noSources") }}</li>
      </ul>

      <p class="field-help" style="margin-top: 24px">{{ t("policy.readOnlyHint") }}</p>
    </template>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <FluentButton @click="policy.show('wizard')">{{ t("policy.backToWizard") }}</FluentButton>
      </div>
    </Teleport>
  </div>
</template>
