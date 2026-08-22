<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { listExistingResources, readLiveFacts } from "../../lib/deploy/inventory";
import { localized, RECIPE_LIMITS, type RecipeInput, type RecipeResource, type ResourceKind } from "../../lib/recipe/types";
import type { ContainerAction } from "../../lib/deploy/types";
import { WinButton, WinCheckBox, WinInfoBar, WinProgressRing } from "../../vendor/winui";

const { t, locale } = useI18n();
const wizard = useWizard();

// ---- resources & worker name ----------------------------------------------

const resources = computed(() => wizard.recipe?.resources ?? []);
const askContainers = computed(() => (wizard.recipe?.worker.containers ?? []).filter((container) => container.mode === "ask"));

function setContainerAction(className: string, event: Event) {
  wizard.containerActions[className] = (event.target as HTMLSelectElement).value as ContainerAction;
}

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
const kinds = computed(() => [...new Set(resources.value.map((resource) => resource.kind))]);

/** Kinds whose listing failed. Nothing on this page can be said about them. */
const unreadableKinds = computed(() => kinds.value.filter((kind) => wizard.inventory[kind] === null));

// One reading of the account per kind, kept for the whole step: the match
// declarations resolve against it, and the deployment adopts out of it rather
// than asking Cloudflare the same question again later.
//
// `alive` because a read started before the user stepped back can otherwise
// land after they return with different credentials, writing another account's
// inventory into this one.
let alive = true;
onUnmounted(() => {
  alive = false;
});

async function readInventory() {
  scanning.value = true;
  for (const kind of kinds.value) delete wizard.inventory[kind];
  await Promise.all([
    ...kinds.value.map(async (kind: ResourceKind) => {
      const entries = await listExistingResources({ ...wizard.credentials }, kind).catch(() => null);
      if (alive) wizard.inventory[kind] = entries;
    }),
    readLive(),
  ]);
  if (alive) scanning.value = false;
}

onMounted(() => void readInventory());

function nameValid(value: string): boolean {
  return RECIPE_LIMITS.namePattern.test(value.trim());
}

function matchOf(resource: RecipeResource) {
  return wizard.resourceMatches[resource.id];
}

/** What to say under one resource's name field. */
type ResourceStatus = "invalid" | "skipped" | "unknown" | "adopt" | "ambiguous" | "collides" | "create";

function resourceStatus(resource: RecipeResource): ResourceStatus {
  const name = (wizard.resourceNames[resource.id] ?? "").trim();
  if (!name) return resource.required ? "invalid" : "skipped";
  if (!nameValid(name)) return "invalid";
  if (!wizard.inventory[resource.kind]) return "unknown";
  if (wizard.adoptions[resource.id]) return "adopt";
  if (wizard.undecidedResources.includes(resource.id)) return "ambiguous";
  if (wizard.collidingResources.includes(resource.id)) return "collides";
  return "create";
}

/** The candidates one pattern turned up, plus the standing option of a new one. */
function candidatesOf(resource: RecipeResource) {
  return matchOf(resource)?.candidates ?? [];
}

function onResourceInput(resource: RecipeResource) {
  wizard.touchResource(resource.id);
}

const workerNameValid = computed(() => nameValid(wizard.workerName));

const resourcesOk = computed(() => {
  if (scanning.value || !workerNameValid.value) return false;
  // An unresolved match is the one thing this page will not decide for the user:
  // picking wrong writes this deployment into somebody else's data.
  if (wizard.undecidedResources.length > 0) return false;
  // Provisioning no longer looks before it creates, so a name already taken has
  // to be settled here rather than failing part-way through the deployment.
  if (wizard.collidingResources.length > 0) return false;
  // Without the account's inventory this page cannot say what will happen, and
  // guessing "it must be new" is how an upgrade lands on an empty database.
  if (unreadableKinds.value.length > 0) return false;
  // Reusing an existing database, bucket, or namespace can let the deployed
  // app write data there, so it needs the same explicit acknowledgement as an
  // existing Worker before the review page can be reached.
  if (wizard.unconfirmedAdoptionResourceIds.length > 0) return false;
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
      <WinInfoBar
        v-if="unreadableKinds.length > 0"
        :IsOpen="true"
        Severity="Error"
        :IsClosable="false"
        :IsIconVisible="false"
      >
        <strong>{{ t("target.inventoryFailedTitle") }}</strong>
        <p style="margin: 6px 0 0">{{ t("target.inventoryFailedBody") }}</p>
        <WinButton style="margin-top: 10px" @Click="readInventory">{{ t("common.retry") }}</WinButton>
      </WinInfoBar>

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
        <p v-else-if="resourceStatus(resource) === 'unknown'" class="field-help tone-bad">
          {{ t("target.inventoryUnreadable") }}
        </p>

        <template v-else-if="resourceStatus(resource) === 'collides'">
          <p class="field-help tone-bad">{{ t("target.nameTaken", { name: wizard.resourceNames[resource.id] }) }}</p>
          <button type="button" class="link-button" @click="wizard.clearAdoption(resource.id)">
            {{ t("target.nameTakenAdopt") }}
          </button>
        </template>

        <template v-else-if="resourceStatus(resource) === 'adopt'">
          <p class="field-help" :class="wizard.mode === 'fresh' ? 'tone-warn' : 'tone-ok'">
            {{ t("target.willAdopt", { name: wizard.adoptions[resource.id].name }) }}
          </p>
          <p v-if="matchOf(resource)?.via === 'declared'" class="field-help">
            {{ t("target.adoptViaDeclared") }}
          </p>
          <p v-else-if="matchOf(resource)?.via === 'pattern'" class="field-help">
            {{ t("target.adoptViaPattern", { pattern: matchOf(resource)?.matched }) }}
          </p>
          <WinCheckBox
            :model-value="wizard.isAdoptionConfirmed(resource.id)"
            @update:model-value="wizard.confirmAdoption(resource.id, $event)"
          >
            <span><span class="required-star" aria-hidden="true">*</span>{{ t("target.adoptConfirm", { name: wizard.adoptions[resource.id].name }) }}</span>
          </WinCheckBox>
          <button type="button" class="link-button" @click="wizard.chooseAdoption(resource.id, '')">
            {{ t("target.adoptInsteadCreate") }}
          </button>
        </template>

        <template v-else-if="resourceStatus(resource) === 'ambiguous'">
          <p class="field-help tone-warn">
            {{ t("target.ambiguousTitle", { pattern: matchOf(resource)?.matched, count: candidatesOf(resource).length }) }}
          </p>
          <p class="field-help">{{ t("target.ambiguousHelp") }}</p>
          <div class="candidate-list">
            <button
              v-for="candidate in candidatesOf(resource)"
              :key="candidate.id"
              type="button"
              class="card-option"
              @click="wizard.chooseAdoption(resource.id, candidate.name)"
            >
              <h3>{{ candidate.name }}</h3>
              <p>{{ t("target.ambiguousUse") }}</p>
            </button>
            <button type="button" class="card-option" @click="wizard.chooseAdoption(resource.id, '')">
              <h3>{{ wizard.resourceNames[resource.id] }}</h3>
              <p>{{ t("target.ambiguousCreate") }}</p>
            </button>
          </div>
        </template>

        <template v-else>
          <p class="field-help">{{ t("target.willCreate", { name: wizard.resourceNames[resource.id] }) }}</p>
          <button
            v-if="matchOf(resource)?.outcome === 'ambiguous' || matchOf(resource)?.outcome === 'adopt'"
            type="button"
            class="link-button"
            @click="wizard.clearAdoption(resource.id)"
          >
            {{ t("target.adoptReconsider") }}
          </button>
        </template>
      </div>

      <div v-if="askContainers.length > 0" class="guide-card">
        <h3>{{ t("target.containersTitle") }}</h3>
        <p class="field-help" style="margin-top: 0">{{ t("target.containersHelp") }}</p>
        <template v-for="container in askContainers" :key="container.className">
          <div class="field container-choice">
            <label :for="`container-${container.className}`">{{ container.className }}</label>
            <select
              :id="`container-${container.className}`"
              :value="wizard.containerActions[container.className] || 'off'"
              @change="setContainerAction(container.className, $event)"
            >
              <option
                v-if="wizard.mode === 'overwrite' && wizard.live.containerClasses.includes(container.className)"
                value="unchanged"
              >
                {{ t("target.containerKeep") }}
              </option>
              <option value="on">{{ t("target.containerEnable") }}</option>
              <option value="off">{{ t("target.containerDisable") }}</option>
            </select>
            <p class="field-help">{{ t("target.containerStateHelp") }}</p>
          </div>
          <p v-if="container.note" class="field-help">{{ localized(container.note, locale) }}</p>
        </template>
        <p v-if="wizard.mode === 'fresh'" class="field-help">{{ t("target.containerDefaultsFresh") }}</p>
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
        <WinButton @Click="wizard.goTo(STEPS.authorize)">{{ t("common.back") }}</WinButton>
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

.candidate-list {
  margin-top: 8px;
}

.link-button {
  margin-top: 4px;
  padding: 0;
  background: none;
  border: 0;
  font: inherit;
  font-size: 12px;
  color: var(--AccentTextFillColorPrimaryBrush, inherit);
  text-decoration: underline;
  cursor: pointer;
}
</style>
