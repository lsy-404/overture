<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { verifyCredentials, type CredentialCheck } from "../../lib/cf/verify";
import { localized } from "../../lib/recipe/types";
import { WinButton } from "../../vendor/winui";

const { t, locale } = useI18n();
const wizard = useWizard();

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const API_TOKEN_RE = /^cfat_[A-Za-z0-9_-]{20,}$/;

// Keyed by the recipe's own permission keys and check ids, plus the checks the
// host always runs ("token", and "r2Keys" when a resource asks for S3 keys).
const statuses = reactive<Record<string, CredentialCheck>>({});
const verifying = ref(false);
const hasAttempted = ref(false);

const permissions = computed(() => wizard.recipe?.permissions ?? []);
const checks = computed(() => wizard.recipe?.checks ?? []);

function statusOf(key: string): CredentialCheck["status"] {
  return statuses[key]?.status ?? "pending";
}

function detailOf(key: string): string {
  return statuses[key]?.detail || "";
}

const canVerify = computed(
  () =>
    ACCOUNT_ID_RE.test(wizard.credentials.accountId.trim()) && API_TOKEN_RE.test(wizard.credentials.apiToken.trim()),
);

const s3PairComplete = computed(() => {
  const key = wizard.credentials.r2AccessKeyId.trim();
  const secret = wizard.credentials.r2SecretAccessKey.trim();
  if (wizard.requiresS3Keys) return !!key && !!secret;
  return (!key && !secret) || (!!key && !!secret);
});

const canContinue = computed(() => wizard.credentialsVerified && s3PairComplete.value);

let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

watch(
  () =>
    [
      wizard.credentials.accountId,
      wizard.credentials.apiToken,
      wizard.credentials.r2AccessKeyId,
      wizard.credentials.r2SecretAccessKey,
    ].join("\0"),
  () => {
    generation++;
    clearTimeout(timer);
    verifying.value = false;
    wizard.credentialsVerified = false;
    for (const key of Object.keys(statuses)) delete statuses[key];
    if (!canVerify.value) return;
    timer = setTimeout(() => void verify(), 500);
  },
  { immediate: true },
);

onUnmounted(() => {
  generation++;
  clearTimeout(timer);
});

async function verify() {
  const recipe = wizard.recipe;
  if (!recipe) return;
  const current = ++generation;
  verifying.value = true;
  hasAttempted.value = true;
  wizard.credentialsVerified = false;
  for (const key of Object.keys(statuses)) delete statuses[key];
  try {
    const outcome = await verifyCredentials({ ...wizard.credentials }, recipe, (check) => {
      if (current !== generation) return;
      statuses[check.key] = check;
    });
    if (current !== generation) return;
    wizard.tokenGroups = outcome.groups;
    wizard.credentialsVerified = outcome.ok;
  } catch (e) {
    if (current !== generation) return;
    statuses.token = { key: "token", status: "error", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (current === generation) verifying.value = false;
  }
}

// Permissions are usually fixed in the Cloudflare dashboard with this page left
// open, and nothing about that reaches the wizard — so re-running the checklist
// needs an explicit control, not another edit of the token field.
function recheck() {
  clearTimeout(timer);
  void verify();
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("credentials.title") }}</h1>
    <p class="step-subtitle">{{ t("credentials.subtitle") }}</p>

    <div class="guide-card">
      <h3>{{ t("credentials.setupTitle") }}</h3>
      <ol>
        <li>
          <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noreferrer">{{ t("credentials.createAccount") }} ↗</a>
        </li>
        <li>
          {{ t("credentials.setupToken") }}
          <a href="https://dash.cloudflare.com/?to=/:account/api-tokens" target="_blank" rel="noreferrer">{{ t("credentials.apiTokenCreateLink") }} ↗</a>
        </li>
        <li>
          <div class="permission-head">
            <span>{{ t("credentials.setupPermissions") }}</span>
            <WinButton Style="SubtleButtonStyle" :IsEnabled="canVerify && !verifying" @Click="recheck">
              <span aria-hidden="true">⟳</span>{{ verifying ? t("credentials.verifying") : t("credentials.recheck") }}
            </WinButton>
          </div>
          <div class="permission-table-wrap">
            <table class="permission-table">
              <thead>
                <tr>
                  <th>{{ t("credentials.permissionRequirement") }}</th>
                  <th>{{ t("credentials.permissionResource") }}</th>
                  <th>{{ t("credentials.permissionScenario") }}</th>
                  <th>{{ t("credentials.permissionScope") }}</th>
                  <th>{{ t("credentials.permissionLevel") }}</th>
                  <th>{{ t("credentials.permissionStatus") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="permission in permissions" :key="permission.key">
                  <td>
                    <span :class="`requirement-${permission.requirement}`">{{ t(`credentials.requirements.${permission.requirement}`) }}</span>
                  </td>
                  <td>
                    {{ localized(permission.label, locale) }}
                    <p class="group-list">{{ permission.groups.join(" / ") }}</p>
                  </td>
                  <td>{{ localized(permission.scenario, locale) }}</td>
                  <td>{{ t(`credentials.permissionScopes.${permission.scope}`) }}</td>
                  <td>{{ t(`credentials.permissionLevels.${permission.level}`) }}</td>
                  <td>
                    <span v-if="hasAttempted" class="check-status" :title="detailOf(permission.key)">
                      <span class="check-dot" :class="`check-dot-${statusOf(permission.key)}`" aria-hidden="true" />
                      {{ t(`credentials.checkStatus.${statusOf(permission.key)}`) }}
                    </span>
                    <span v-else class="check-status">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="hasAttempted" class="field-help check-status">
            <span class="check-dot" :class="`check-dot-${statusOf('token')}`" aria-hidden="true" />
            {{ t("credentials.tokenCheck") }}: {{ t(`credentials.checkStatus.${statusOf("token")}`) }}
            <template v-if="detailOf('token')">— {{ detailOf("token") }}</template>
          </p>
        </li>
      </ol>
    </div>

    <div class="field">
      <label for="accountId">{{ t("credentials.accountId") }}<span class="field-tag required">{{ t("common.required") }}</span></label>
      <input id="accountId" v-model.trim="wizard.credentials.accountId" type="text" autocomplete="off" spellcheck="false" />
      <p class="field-help">{{ t("credentials.accountIdHelp") }}</p>
    </div>

    <div class="field">
      <label for="apiToken">{{ t("credentials.apiToken") }}<span class="field-tag required">{{ t("common.required") }}</span></label>
      <input id="apiToken" v-model.trim="wizard.credentials.apiToken" type="password" autocomplete="off" spellcheck="false" />
      <p class="field-help">{{ t("credentials.apiTokenHelp") }}</p>
      <p class="field-help">{{ t("credentials.apiTokenStorageNote") }}</p>
    </div>

    <template v-if="wizard.needsS3Keys">
      <div class="field">
        <label for="r2Key">
          {{ t("credentials.r2AccessKeyId") }}
          <span class="field-tag" :class="wizard.requiresS3Keys ? 'required' : 'optional'">
            {{ wizard.requiresS3Keys ? t("common.required") : t("common.optional") }}
          </span>
        </label>
        <input id="r2Key" v-model.trim="wizard.credentials.r2AccessKeyId" type="text" autocomplete="off" spellcheck="false" />
      </div>
      <div class="field">
        <label for="r2Secret">
          {{ t("credentials.r2SecretAccessKey") }}
          <span class="field-tag" :class="wizard.requiresS3Keys ? 'required' : 'optional'">
            {{ wizard.requiresS3Keys ? t("common.required") : t("common.optional") }}
          </span>
        </label>
        <input id="r2Secret" v-model.trim="wizard.credentials.r2SecretAccessKey" type="password" autocomplete="off" spellcheck="false" />
        <p class="field-help">{{ t("credentials.r2KeyHelp") }}</p>
        <p v-if="!s3PairComplete" class="field-help tone-bad">{{ t("credentials.r2KeysPairRequired") }}</p>
        <p v-if="hasAttempted && statusOf('r2Keys') !== 'pending'" class="field-help check-status">
          <span class="check-dot" :class="`check-dot-${statusOf('r2Keys')}`" aria-hidden="true" />
          {{ t(`credentials.checkStatus.${statusOf("r2Keys")}`) }}
          <template v-if="detailOf('r2Keys')">— {{ detailOf("r2Keys") }}</template>
        </p>
      </div>
    </template>

    <div v-if="checks.length > 0" class="guide-card">
      <h3>{{ t("credentials.checksTitle") }}</h3>
      <p class="field-help" style="margin-top: 0">{{ t("credentials.checksHelp") }}</p>
      <div class="permission-table-wrap">
        <table class="permission-table">
          <thead>
            <tr>
              <th>{{ t("credentials.permissionRequirement") }}</th>
              <th>{{ t("credentials.checkLabel") }}</th>
              <th>{{ t("credentials.permissionStatus") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="check in checks" :key="check.id">
              <td>
                <span :class="`requirement-${check.requirement}`">{{ t(`credentials.requirements.${check.requirement}`) }}</span>
              </td>
              <td>
                {{ localized(check.label, locale) }}
                <p v-if="check.hint" class="group-list">{{ localized(check.hint, locale) }}</p>
              </td>
              <td>
                <span v-if="hasAttempted" class="check-status" :title="detailOf(check.id)">
                  <span class="check-dot" :class="`check-dot-${statusOf(check.id)}`" aria-hidden="true" />
                  {{ t(`credentials.checkStatus.${statusOf(check.id)}`) }}
                </span>
                <span v-else class="check-status">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <p v-if="hasAttempted && !verifying && !wizard.credentialsVerified" class="field-help tone-warn">
      {{ t("credentials.blocked") }}
    </p>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="wizard.goTo(STEPS.version)">{{ t("common.back") }}</WinButton>
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="canContinue" @Click="wizard.goTo(STEPS.target)">
          {{ t("common.next") }}
        </WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.group-list {
  margin: 2px 0 0;
  font-size: 0.7rem;
  color: var(--text-secondary);
  font-family: var(--font-mono);
}
</style>
