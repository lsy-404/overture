<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { listExistingNames, readLiveFacts } from "../../lib/deploy/inventory";
import { localized, RECIPE_LIMITS, type RecipeInput, type RecipeResource, type ResourceKind } from "../../lib/recipe/types";
import { WinButton, WinCheckBox, WinProgressRing } from "../../vendor/winui";

const { t, locale } = useI18n();
const wizard = useWizard();

// ---- resources & worker name ----------------------------------------------

const resources = computed(() => wizard.recipe?.resources ?? []);
const askContainers = computed(() => (wizard.recipe?.worker.containers ?? []).filter((container) => container.mode === "ask"));

/** Names already in the account, per resource kind. null when unreadable. */
const existing = reactive<Record<string, string[] | null>>({});
const scanning = ref(true);

const liveChecking = ref(false);
const liveError = ref(false);
let liveGeneration = 0;
let liveTimer: ReturnType<typeof setTimeout> | undefined;

async function readLive() {
  const name = wizard.workerName.trim();
  if (!name) return;
  const current = ++liveGeneration;
  liveChecking.value = true;
  liveError.value = false;
  try {
    const facts = await readLiveFacts({ ...wizard.credentials }, name);
    if (current === liveGeneration) wizard.applyLive(facts);
  } catch {
    if (current === liveGeneration) liveError.value = true;
  } finally {
    if (current === liveGeneration) liveChecking.value = false;
  }
}

watch(
  () => wizard.workerName,
  () => {
    liveGeneration++;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(readLive, 500);
  },
);

onUnmounted(() => {
  liveGeneration++;
  clearTimeout(liveTimer);
});

// Everything this page states about the account is fetched once behind a cover,
// so the Worker and storage answers land together instead of rewriting the form
// under the user as each one arrives.
onMounted(async () => {
  const kinds = [...new Set(resources.value.map((resource) => resource.kind))];
  await Promise.all([
    ...kinds.map(async (kind: ResourceKind) => {
      existing[kind] = await listExistingNames({ ...wizard.credentials }, kind).catch(() => null);
    }),
    readLive(),
  ]);
  scanning.value = false;
});

type NameState = "exists" | "absent" | "unknown";

function nameState(resource: RecipeResource): NameState {
  const names = existing[resource.kind];
  if (!names) return "unknown";
  return names.includes((wizard.resourceNames[resource.id] ?? "").trim()) ? "exists" : "absent";
}

function nameValid(value: string): boolean {
  return RECIPE_LIMITS.namePattern.test(value.trim());
}

/** What to say under one resource's name field. */
function resourceStatus(resource: RecipeResource): "invalid" | "skipped" | NameState {
  const name = (wizard.resourceNames[resource.id] ?? "").trim();
  if (!name) return resource.required ? "invalid" : "skipped";
  if (!nameValid(name)) return "invalid";
  return nameState(resource);
}

function onResourceInput(resource: RecipeResource) {
  wizard.touchResource(resource.id);
}

const workerNameValid = computed(() => nameValid(wizard.workerName));

const resourcesOk = computed(() => {
  if (scanning.value || !workerNameValid.value) return false;
  for (const resource of resources.value) {
    const name = (wizard.resourceNames[resource.id] ?? "").trim();
    if (!name && !resource.required) continue;
    if (!nameValid(name)) return false;
  }
  return wizard.mode === "fresh" || wizard.overwriteConfirmed;
});

// ---- options ----------------------------------------------------------------

const revealed = ref<Record<string, boolean>>({});

const inputs = computed(() => wizard.activeInputs);

function stringValue(input: RecipeInput): string {
  const value = wizard.inputs[input.id];
  return typeof value === "string" ? value : "";
}

function patternOk(input: RecipeInput): boolean {
  if (!input.pattern) return true;
  const value = stringValue(input).trim();
  if (!value) return true;
  try {
    return new RegExp(`^(?:${input.pattern})$`).test(value);
  } catch {
    // A recipe's own regular expression is third-party text; an unusable one
    // must not turn into a field the user can never satisfy.
    return true;
  }
}

function missing(input: RecipeInput): boolean {
  return input.required === true && input.kind !== "toggle" && !stringValue(input).trim();
}

const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generate(input: RecipeInput) {
  const length = Math.min(64, Math.max(8, input.generate || 16));
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let value = "";
  for (const byte of bytes) value += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
  wizard.inputs[input.id] = value;
  revealed.value[input.id] = true;
}

const optionsOk = computed(() => inputs.value.every((input) => !missing(input) && (input.kind !== "domain" || patternOk(input))));

const canContinue = computed(() => resourcesOk.value && optionsOk.value);
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("target.title") }}</h1>
    <p class="step-subtitle">{{ t("target.subtitle") }}</p>

    <div v-if="scanning" class="inline-status">
      <WinProgressRing :Width="20" :Height="20" :IsActive="true" />
      <span>{{ t("target.scanning") }}</span>
    </div>

    <template v-else>
      <div class="field">
        <label for="workerName">{{ t("target.workerName") }}</label>
        <input id="workerName" v-model.trim="wizard.workerName" type="text" spellcheck="false" @blur="readLive" />
        <p class="field-help">{{ t("target.workerNameHelp") }}</p>
        <p v-if="!workerNameValid" class="field-help tone-bad">{{ t("target.nameInvalid") }}</p>
        <p v-else-if="liveChecking" class="field-help">{{ t("target.workerChecking") }}</p>
        <p v-else-if="liveError" class="field-help tone-warn">{{ t("target.workerUnknown") }}</p>
        <p v-else-if="wizard.mode === 'overwrite'" class="field-help tone-warn">
          {{ t("target.workerExists", { name: wizard.workerName }) }}
        </p>
        <p v-else class="field-help tone-ok">{{ t("target.workerFresh", { name: wizard.workerName }) }}</p>
      </div>

      <template v-if="wizard.mode === 'overwrite'">
        <WinCheckBox v-model="wizard.overwriteConfirmed">
          <span><span class="required-star" aria-hidden="true">*</span>{{ t("target.overwriteConfirm", { name: wizard.workerName }) }}</span>
        </WinCheckBox>
        <WinCheckBox v-if="wizard.overwriteConfirmed" v-model="wizard.fullRebuild">
          {{ t("target.fullRebuild") }}
        </WinCheckBox>
        <p v-if="wizard.fullRebuild" class="field-help tone-warn">{{ t("target.fullRebuildHelp") }}</p>
      </template>

      <div v-for="resource in resources" :key="resource.id" class="field">
        <label :for="`res-${resource.id}`">
          {{ t(`target.kinds.${resource.kind}`) }} — {{ localized(resource.label, locale) }}
          <span class="field-tag" :class="resource.required ? 'required' : 'optional'">
            {{ resource.required ? t("common.required") : t("common.optional") }}
          </span>
        </label>
        <input
          :id="`res-${resource.id}`"
          v-model.trim="wizard.resourceNames[resource.id]"
          type="text"
          spellcheck="false"
          @input="onResourceInput(resource)"
        />
        <p v-if="resource.help" class="field-help">{{ localized(resource.help, locale) }}</p>
        <p class="field-help">{{ t("target.bindingNote", { binding: resource.binding }) }}</p>
        <p v-if="resourceStatus(resource) === 'invalid'" class="field-help tone-bad">{{ t("target.nameInvalid") }}</p>
        <p v-else-if="resourceStatus(resource) === 'skipped'" class="field-help">{{ t("target.nameSkipped") }}</p>
        <p v-else-if="resourceStatus(resource) === 'unknown'" class="field-help tone-warn">
          {{ t("target.nameUnknown", { name: wizard.resourceNames[resource.id] }) }}
        </p>
        <p v-else-if="resourceStatus(resource) === 'exists'" class="field-help" :class="wizard.mode === 'fresh' ? 'tone-warn' : 'tone-ok'">
          {{ t("target.nameExists", { name: wizard.resourceNames[resource.id] }) }}
        </p>
        <p v-else class="field-help">{{ t("target.nameAbsent", { name: wizard.resourceNames[resource.id] }) }}</p>
      </div>

      <div v-if="askContainers.length > 0" class="guide-card">
        <h3>{{ t("target.containersTitle") }}</h3>
        <p class="field-help" style="margin-top: 0">{{ t("target.containersHelp") }}</p>
        <template v-for="container in askContainers" :key="container.className">
          <WinCheckBox v-model="wizard.containerChoices[container.className]">
            <span>{{ t("target.containerDeclare", { name: container.className }) }}</span>
          </WinCheckBox>
          <p v-if="container.note" class="field-help">{{ localized(container.note, locale) }}</p>
        </template>
      </div>

      <template v-if="inputs.length > 0">
        <h3 class="section-heading">{{ t("target.optionsHeading") }}</h3>

        <div v-for="input in inputs" :key="input.id" class="field">
          <template v-if="input.kind === 'toggle'">
            <WinCheckBox v-model="wizard.inputs[input.id]">
              <span>{{ localized(input.label, locale) }}</span>
            </WinCheckBox>
            <p v-if="input.help" class="field-help">{{ localized(input.help, locale) }}</p>
          </template>

          <template v-else>
            <label :for="`input-${input.id}`">
              {{ localized(input.label, locale) }}
              <span class="field-tag" :class="input.required ? 'required' : 'optional'">
                {{ input.required ? t("common.required") : t("common.optional") }}
              </span>
            </label>

            <select v-if="input.kind === 'select'" :id="`input-${input.id}`" v-model="wizard.inputs[input.id]">
              <option v-for="option in input.options || []" :key="option.value" :value="option.value">
                {{ localized(option.label, locale) }}
              </option>
            </select>

            <div v-else-if="input.kind === 'password'" class="password-row">
              <input
                :id="`input-${input.id}`"
                v-model="wizard.inputs[input.id]"
                :type="revealed[input.id] ? 'text' : 'password'"
                autocomplete="new-password"
                spellcheck="false"
              />
              <WinButton @Click="revealed[input.id] = !revealed[input.id]">
                {{ revealed[input.id] ? t("common.hide") : t("common.show") }}
              </WinButton>
              <WinButton v-if="input.generate" @Click="generate(input)">{{ t("target.generate") }}</WinButton>
            </div>

            <input
              v-else
              :id="`input-${input.id}`"
              v-model.trim="wizard.inputs[input.id]"
              type="text"
              spellcheck="false"
              autocomplete="off"
              :placeholder="input.kind === 'domain' ? t('target.domainPlaceholder') : ''"
            />

            <p v-if="input.help" class="field-help">{{ localized(input.help, locale) }}</p>
            <p v-if="missing(input)" class="field-help tone-bad">{{ t("target.requiredMissing") }}</p>
            <p v-else-if="!patternOk(input)" class="field-help" :class="input.kind === 'domain' ? 'tone-bad' : 'tone-warn'">
              {{ input.kind === "domain" ? t("target.domainInvalid") : t("target.patternAdvisory") }}
            </p>
          </template>
        </div>
      </template>
    </template>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="wizard.goTo(STEPS.credentials)">{{ t("common.back") }}</WinButton>
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="canContinue" @Click="wizard.goTo(STEPS.confirm)">
          {{ t("common.next") }}
        </WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.password-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.password-row input {
  flex: 1;
  min-width: 0;
}
</style>
