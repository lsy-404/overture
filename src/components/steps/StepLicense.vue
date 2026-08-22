<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { renderMarkdown } from "../../lib/markdown";
import { WinButton, WinCheckBox } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();

const hasTerms = computed(() => wizard.termsText.trim().length > 0);
const mustAccept = computed(() => hasTerms.value && wizard.recipe?.terms?.required === true);
const termsHtml = computed(() => renderMarkdown(wizard.termsText));
const licenseHtml = computed(() => renderMarkdown(wizard.licenseText));

wizard.termsAccepted = false;

const termsPane = ref<HTMLElement | null>(null);
const termsRead = ref(!hasTerms.value);

function checkTermsRead() {
  const element = termsPane.value;
  if (!element) return;
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 4) termsRead.value = true;
}

onMounted(() => {
  if (hasTerms.value) checkTermsRead();
});

const canContinue = computed(() => !mustAccept.value || wizard.termsAccepted);

// The selector page only exists when there is a real choice to make; exactly
// one available mode skips straight into it rather than showing a chooser
// with a single, forced-looking option. Zero available modes also goes to the
// selector page, which is where that dead end is explained.
function goNext() {
  const available = wizard.availableAuthModes;
  if (available.length === 1) {
    wizard.setAuthMode(available[0]);
    wizard.goTo(STEPS.authorize);
    return;
  }
  wizard.goTo(STEPS.authMethod);
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("license.title") }}</h1>
    <p class="step-subtitle">{{ t("license.subtitle") }}</p>

    <template v-if="hasTerms">
      <h3 class="section-heading">{{ t("license.termsSection") }}</h3>
      <div
        ref="termsPane"
        class="text-pane markdown-pane"
        tabindex="0"
        @scroll="checkTermsRead"
        v-html="termsHtml"
      ></div>
      <div v-if="mustAccept" class="accept-row">
        <WinCheckBox v-model="wizard.termsAccepted" :IsEnabled="termsRead">
          <span><span class="required-star" aria-hidden="true">*</span>{{ t("license.accept") }}</span>
        </WinCheckBox>
        <span v-if="!termsRead" class="field-help accept-hint">{{ t("license.scrollToEnd") }}</span>
      </div>
      <p v-else class="field-help accept-hint">{{ t("license.acceptOptional") }}</p>
    </template>

    <h3 class="section-heading">{{ t("license.licenseSection", { id: wizard.recipe?.license.id }) }}</h3>
    <div class="text-pane" tabindex="0">
      <div v-if="wizard.licenseText" class="markdown-pane" v-html="licenseHtml"></div>
      <p v-else>{{ t("license.licenseMissing") }}</p>
    </div>
    <p v-if="!hasTerms" class="field-help accept-hint">{{ t("license.noTerms") }}</p>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="wizard.goTo(STEPS.repository)">{{ t("common.back") }}</WinButton>
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="canContinue" @Click="goNext">
          {{ t("common.next") }}
        </WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.accept-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 14px;
}

.accept-hint {
  margin: 14px 0 0;
}

.markdown-pane {
  font-size: 0.85rem;
  line-height: 1.6;
  color: var(--text-primary);
}

.markdown-pane :deep(h1),
.markdown-pane :deep(h2),
.markdown-pane :deep(h3),
.markdown-pane :deep(h4) {
  margin: 1.2em 0 0.5em;
  font-size: 1em;
  font-weight: 600;
}

.markdown-pane :deep(h1:first-child),
.markdown-pane :deep(h2:first-child),
.markdown-pane :deep(h3:first-child),
.markdown-pane :deep(h4:first-child) {
  margin-top: 0;
}

.markdown-pane :deep(p) {
  margin: 0 0 0.8em;
}

.markdown-pane :deep(ul),
.markdown-pane :deep(ol) {
  margin: 0 0 0.8em;
  padding-left: 1.4em;
}

.markdown-pane :deep(li + li) {
  margin-top: 0.3em;
}

.markdown-pane :deep(a) {
  color: var(--accent-base);
}

.markdown-pane :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--card-bg-secondary);
  padding: 0.1em 0.35em;
  border-radius: 4px;
}

.markdown-pane :deep(blockquote) {
  margin: 0 0 0.8em;
  padding-left: 0.8em;
  border-left: 2px solid var(--card-stroke);
  color: var(--text-secondary);
}
</style>
