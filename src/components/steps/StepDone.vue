<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { localized } from "../../lib/recipe/types";
import { WinButton, WinCheckBox, WinInfoBar } from "../../vendor/winui";

const { t, locale } = useI18n();
const wizard = useWizard();

const copiedField = ref("");
const revealed = ref<Record<number, boolean>>({});
const clearCredentials = ref(true);

interface ConfettiPiece {
  id: number;
  style: Record<string, string>;
}
const confettiPieces = ref<ConfettiPiece[]>([]);

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#0067C0", "#4CC2FF", "#FFB900", "#E74856", "#00CC6A", "#B146C2"];
  confettiPieces.value = Array.from({ length: 70 }, (_, index) => ({
    id: index,
    style: {
      left: `${Math.random() * 100}%`,
      background: colors[index % colors.length],
      animationDelay: `${Math.random() * 0.5}s`,
      animationDuration: `${2.2 + Math.random() * 1.4}s`,
      "--confetti-drift": `${(Math.random() - 0.5) * 140}px`,
      "--confetti-spin": `${Math.random() > 0.5 ? "" : "-"}${540 + Math.random() * 360}deg`,
    },
  }));
  setTimeout(() => {
    confettiPieces.value = [];
  }, 4000);
});

const result = computed(() => wizard.result);
const links = computed(() =>
  (wizard.recipe?.done?.links ?? []).map((link) => ({
    label: localized(link.label, locale.value),
    href: wizard.interpolate(link.href, { url: result.value?.url || "" }),
  })),
);
const doneNotes = computed(() => localized(wizard.recipe?.done?.notes, locale.value));

async function copy(text: string, field: string) {
  try {
    await navigator.clipboard.writeText(text);
    copiedField.value = field;
    setTimeout(() => {
      if (copiedField.value === field) copiedField.value = "";
    }, 1500);
  } catch {
    // Clipboard unavailable (insecure context, permission denied) — the value is
    // still on screen and selectable, so this is a soft failure.
  }
}

function maskedValue(value: string): string {
  return "•".repeat(Math.min(16, Math.max(6, value.length)));
}

function finish() {
  if (clearCredentials.value) wizard.clearCredentials(true);
  location.reload();
}
</script>

<template>
  <div>
    <Teleport to="body">
      <div class="confetti-layer" aria-hidden="true">
        <span v-for="piece in confettiPieces" :key="piece.id" class="confetti-piece" :style="piece.style" />
      </div>
    </Teleport>

    <h1 class="step-title">{{ t("done.title", { app: wizard.recipe?.name || "" }) }}</h1>

    <template v-if="result?.url">
      <p class="field-help">{{ t("done.urlLabel") }}</p>
      <p style="margin: 4px 0 16px; word-break: break-all">{{ result.url }}</p>
      <a :href="result.url" target="_blank" rel="noreferrer" class="btn open-link">{{ t("done.openLink") }} ↗</a>
    </template>

    <WinInfoBar :IsOpen="true" Severity="Informational" :IsClosable="false" :IsIconVisible="false" style="margin-top: 16px">
      {{ t("done.propagationNotice") }}
    </WinInfoBar>

    <section v-if="(result?.credentials || []).length > 0" class="guide-card">
      <h3>{{ t("done.credentialsTitle") }}</h3>
      <div v-for="(credential, index) in result?.credentials || []" :key="`${credential.label}-${index}`" class="credential-row">
        <span class="credential-label">{{ credential.label }}</span>
        <code class="credential-value">{{ credential.secret && !revealed[index] ? maskedValue(credential.value) : credential.value }}</code>
        <WinButton v-if="credential.secret" style="padding: 2px 10px; font-size: 0.75rem" @Click="revealed[index] = !revealed[index]">
          {{ revealed[index] ? t("common.hide") : t("common.show") }}
        </WinButton>
        <WinButton style="padding: 2px 10px; font-size: 0.75rem" @Click="copy(credential.value, `cred-${index}`)">
          {{ copiedField === `cred-${index}` ? t("common.copied") : t("common.copy") }}
        </WinButton>
      </div>
      <p style="margin: 10px 0 0">{{ t("done.saveWarning") }}</p>
    </section>

    <section v-if="(result?.notes || []).length > 0 || doneNotes" class="guide-card">
      <h3>{{ t("done.notesTitle") }}</h3>
      <p v-if="doneNotes" class="field-help" style="margin-top: 0">{{ doneNotes }}</p>
      <ul class="plain-list">
        <li v-for="(note, index) in result?.notes || []" :key="index">{{ note }}</li>
      </ul>
    </section>

    <section v-if="links.length > 0" class="link-row">
      <a v-for="link in links" :key="link.href" :href="link.href" target="_blank" rel="noreferrer" class="btn">{{ link.label }} ↗</a>
    </section>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <div class="spacer" />
        <WinCheckBox v-model="clearCredentials" class="clear-credentials-check">
          <span>{{ t("done.clearCredentials") }}</span>
        </WinCheckBox>
        <WinButton Style="AccentButtonStyle" @Click="finish">{{ t("done.finish") }}</WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.open-link {
  width: 100%;
}

.link-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

/* The global rule stacks checkboxes in a column; this one sits inline in the
   action bar next to the finish button. */
.clear-credentials-check {
  margin-bottom: 0;
  margin-right: 8px;
}
</style>
