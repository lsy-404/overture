<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { verifyAccount, type CredentialCheck } from "../../lib/cf/verify";
import { fetchOAuthSession, oauthAuthorizeUrl, selectOAuthAccount, submitAuthToken } from "../../lib/relay";
import { localized } from "../../lib/recipe/types";
import { WinButton } from "../../vendor/winui";

const { t, locale } = useI18n();
const wizard = useWizard();

// Cloudflare's own token management page — there is no stable deep link into
// the creation form itself, so this is as far as a link can safely take the
// user; the rest is the page's own copy telling them what to build.
const CF_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

const titleKey = computed(() => {
  if (wizard.authMode === "auto") return "authorize.auto.title";
  if (wizard.authMode === "manual") return "authorize.manual.title";
  return "authorize.title";
});
const subtitleKey = computed(() => {
  if (wizard.authMode === "auto") return "authorize.auto.subtitle";
  if (wizard.authMode === "manual") return "authorize.manual.subtitle";
  return "authorize.subtitle";
});

/** The long-lived token this app wants, when the recipe declares one. */
const cfApiTokenSecret = computed(() => wizard.recipe?.hostSecrets?.find((secret) => secret.source === "cfApiToken"));

function goBack() {
  wizard.goTo(wizard.hasAuthChoice ? STEPS.authMethod : STEPS.license);
}

// ---- sign-in popup (oauth mode) --------------------------------------------

const signingIn = ref(false);
const popupError = ref("");
let popupRef: Window | null = null;
let popupWatch: ReturnType<typeof setInterval> | undefined;

function stopPopupWatch() {
  clearInterval(popupWatch);
  popupWatch = undefined;
}

function watchPopup(popup: Window) {
  stopPopupWatch();
  popupWatch = setInterval(() => {
    let closed = true;
    try {
      closed = popup.closed;
    } catch {
      closed = true;
    }
    if (closed && popupRef === popup) {
      popupRef = null;
      signingIn.value = false;
      stopPopupWatch();
    }
  }, 500);
}

/**
 * Must run inside the click handler's own call stack — nothing awaited before
 * `window.open`, or the browser treats the popup as unrequested and blocks it.
 */
function startSignIn() {
  const recipe = wizard.recipe;
  if (!recipe) return;
  popupError.value = "";
  const url = oauthAuthorizeUrl(wizard.requestedScope, recipe.package.sha256);
  const popup = window.open(url, "overture-oauth", "width=520,height=720");
  if (!popup) {
    popupError.value = t("authorize.popupBlocked");
    return;
  }
  popupRef = popup;
  signingIn.value = true;
  watchPopup(popup);
}

async function autoSelectAccount() {
  if (wizard.oauthAccounts.length === 1 && !wizard.credentials.accountId) {
    await chooseAccount(wizard.oauthAccounts[0].id);
  }
}

async function onMessage(event: MessageEvent) {
  // The popup's own signal carries no data worth trusting beyond its
  // identity — everything about the grant is re-read from `GET /oauth/session`
  // once this fires, never taken from the message itself.
  if (!popupRef || event.source !== popupRef || event.origin !== location.origin || event.data !== "oauth:complete") return;
  stopPopupWatch();
  // The callback page closes itself; this is only a backstop for a popup that
  // did not, so a signal that already fired never leaves a stray window open.
  try {
    popupRef.close();
  } catch {
    // Cross-origin by then in some browsers — nothing to do about it.
  }
  popupRef = null;
  signingIn.value = false;
  try {
    wizard.applyOAuthSession(await fetchOAuthSession());
    await autoSelectAccount();
  } catch (e) {
    popupError.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(async () => {
  window.addEventListener("message", onMessage);
  try {
    wizard.applyOAuthSession(await fetchOAuthSession());
    if (wizard.sessionMatchesPackage) await autoSelectAccount();
  } catch {
    // Nothing on hand yet — the sign-in button covers this, no banner needed
    // for a check that simply found no session.
  }
});

onUnmounted(() => {
  window.removeEventListener("message", onMessage);
  stopPopupWatch();
});

// ---- pasted token (auto and manual modes) ----------------------------------
// The value lives only in this local ref, never in the wizard store: it is
// posted to the relay and dropped from this component the moment the request
// settles, success or failure alike.

const pasteToken = ref("");
const submitting = ref(false);
const submitError = ref("");

const canSubmitToken = computed(() => pasteToken.value.trim().length > 0 && !submitting.value);

async function submitToken() {
  const recipe = wizard.recipe;
  const mode = wizard.authMode;
  if (!recipe || (mode !== "auto" && mode !== "manual")) return;
  const value = pasteToken.value.trim();
  if (!value) return;
  submitting.value = true;
  submitError.value = "";
  try {
    const session = await submitAuthToken(value, mode, recipe.package.sha256);
    wizard.applyOAuthSession(session);
    // Manual mode's one token covers both deploy and the app's own long-lived
    // credential, so the value the user just typed is what gets handed to the
    // app later — unlike auto mode's pasted value, which is powerful and never
    // kept past this request.
    if (mode === "manual") wizard.credentials.cfApiToken = value;
    await autoSelectAccount();
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : String(e);
  } finally {
    pasteToken.value = "";
    submitting.value = false;
  }
}

// ---- account -----------------------------------------------------------

const selectingAccount = ref(false);

async function chooseAccount(accountId: string) {
  selectingAccount.value = true;
  popupError.value = "";
  try {
    wizard.applyOAuthSession(await selectOAuthAccount(accountId));
  } catch (e) {
    popupError.value = e instanceof Error ? e.message : String(e);
  } finally {
    selectingAccount.value = false;
  }
}

// ---- account checks & R2 keys -------------------------------------------

const statuses = reactive<Record<string, CredentialCheck>>({});
const verifying = ref(false);
const hasAttempted = ref(false);
const verifyError = ref("");

const checks = computed(() => wizard.recipe?.checks ?? []);

function statusOf(key: string): CredentialCheck["status"] {
  return statuses[key]?.status ?? "pending";
}

function detailOf(key: string): string {
  return statuses[key]?.detail || "";
}

const s3PairComplete = computed(() => {
  const key = wizard.credentials.r2AccessKeyId.trim();
  const secret = wizard.credentials.r2SecretAccessKey.trim();
  if (wizard.requiresS3Keys) return !!key && !!secret;
  return (!key && !secret) || (!!key && !!secret);
});

const canVerify = computed(() => wizard.sessionMatchesPackage && !!wizard.credentials.accountId);
const canContinue = computed(() => canVerify.value && wizard.accountVerified && s3PairComplete.value);

let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => [wizard.credentials.accountId, wizard.credentials.r2AccessKeyId, wizard.credentials.r2SecretAccessKey].join("\0"),
  () => {
    generation++;
    clearTimeout(timer);
    verifying.value = false;
    wizard.accountVerified = false;
    verifyError.value = "";
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
  wizard.accountVerified = false;
  verifyError.value = "";
  for (const key of Object.keys(statuses)) delete statuses[key];
  try {
    const outcome = await verifyAccount({ ...wizard.credentials }, recipe, (check) => {
      if (current !== generation) return;
      statuses[check.key] = check;
    });
    if (current !== generation) return;
    wizard.accountVerified = outcome.ok;
  } catch (e) {
    if (current !== generation) return;
    verifyError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (current === generation) verifying.value = false;
  }
}

function recheck() {
  clearTimeout(timer);
  void verify();
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t(titleKey) }}</h1>
    <p class="step-subtitle">{{ t(subtitleKey) }}</p>

    <div class="guide-card">
      <h3>{{ t("authorize.appScopesTitle") }}</h3>
      <ul class="plain-list">
        <li v-for="permission in wizard.recipe?.permissions ?? []" :key="permission.key">
          <span :class="`requirement-${permission.requirement}`">{{ t(`authorize.requirements.${permission.requirement}`) }}</span>
          {{ localized(permission.label, locale) }}
          <p class="field-help" style="margin: 2px 0 0">{{ localized(permission.scenario, locale) }}</p>
        </li>
        <li v-if="(wizard.recipe?.permissions ?? []).length === 0">{{ t("authorize.appScopesNone") }}</li>
      </ul>

      <h3>{{ t("authorize.hostScopesTitle") }}</h3>
      <p class="field-help" style="margin-top: 0">{{ t("authorize.hostScopesIntro") }}</p>
      <p class="field-help scope-codes">{{ wizard.hostBaselineScope.join(" ") }}</p>
    </div>

    <template v-if="!wizard.sessionMatchesPackage">
      <template v-if="wizard.authMode === 'oauth'">
        <WinButton Style="AccentButtonStyle" :IsEnabled="!signingIn" @Click="startSignIn">
          {{ signingIn ? t("authorize.signingIn") : t("authorize.signInButton") }}
        </WinButton>
        <p v-if="popupError" class="field-help tone-bad">{{ popupError }}</p>
      </template>

      <template v-else-if="wizard.authMode === 'auto'">
        <div class="guide-card">
          <h3>{{ t("authorize.auto.requirementsTitle") }}</h3>
          <p class="field-help" style="margin-top: 0">{{ t("authorize.auto.requirementsBaseline") }}</p>
          <template v-if="cfApiTokenSecret">
            <p class="field-help">{{ t("authorize.auto.requirementsAppIntro") }}</p>
            <p class="field-help scope-codes">{{ cfApiTokenSecret.groups?.join(", ") }}</p>
          </template>
          <p v-else class="field-help">{{ t("authorize.auto.requirementsFallback") }}</p>
        </div>
        <p class="field-help">{{ t("authorize.auto.intro") }}</p>
        <a class="btn" :href="CF_TOKENS_URL" target="_blank" rel="noopener noreferrer">{{ t("authorize.auto.tokenLinkLabel") }}</a>
        <div class="field">
          <label for="autoToken">{{ t("authorize.auto.tokenLabel") }}</label>
          <input
            id="autoToken"
            v-model="pasteToken"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('authorize.auto.placeholder')"
          />
          <p class="field-help">{{ t("authorize.auto.selfDeleteNote") }}</p>
        </div>
        <WinButton Style="AccentButtonStyle" :IsEnabled="canSubmitToken" @Click="submitToken">
          {{ submitting ? t("authorize.auto.submitting") : t("authorize.auto.submit") }}
        </WinButton>
        <p v-if="submitError" class="field-help tone-bad">{{ submitError }}</p>
      </template>

      <template v-else-if="wizard.authMode === 'manual'">
        <div class="guide-card">
          <h3>{{ t("authorize.manual.requirementsTitle") }}</h3>
          <template v-if="cfApiTokenSecret">
            <p class="field-help" style="margin-top: 0">{{ t("authorize.manual.requirementsAppIntro") }}</p>
            <p class="field-help scope-codes">{{ cfApiTokenSecret.groups?.join(", ") }}</p>
          </template>
          <p v-else class="field-help" style="margin-top: 0">{{ t("authorize.manual.requirementsFallback") }}</p>
        </div>
        <p class="field-help">{{ t("authorize.manual.intro") }}</p>
        <a class="btn" :href="CF_TOKENS_URL" target="_blank" rel="noopener noreferrer">{{ t("authorize.manual.tokenLinkLabel") }}</a>
        <div class="field">
          <label for="manualToken">{{ t("authorize.manual.tokenLabel") }}</label>
          <input
            id="manualToken"
            v-model="pasteToken"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('authorize.manual.placeholder')"
          />
        </div>
        <WinButton Style="AccentButtonStyle" :IsEnabled="canSubmitToken" @Click="submitToken">
          {{ submitting ? t("authorize.manual.submitting") : t("authorize.manual.submit") }}
        </WinButton>
        <p v-if="submitError" class="field-help tone-bad">{{ submitError }}</p>
      </template>
    </template>

    <template v-else>
      <div class="guide-card">
        <h3>{{ t("authorize.grantedTitle") }}</h3>
        <p class="field-help scope-codes" style="margin-top: 0">{{ wizard.oauthScope.join(" ") }}</p>
        <WinButton v-if="wizard.authMode === 'oauth'" Style="SubtleButtonStyle" :IsEnabled="!signingIn" @Click="startSignIn">
          {{ t("authorize.signInAgain") }}
        </WinButton>
        <p v-if="popupError" class="field-help tone-bad">{{ popupError }}</p>
      </div>

      <div v-if="wizard.oauthAccounts.length > 1" class="guide-card">
        <h3>{{ t("authorize.accountsTitle") }}</h3>
        <p class="field-help" style="margin-top: 0">{{ t("authorize.accountsHelp") }}</p>
        <button
          v-for="account in wizard.oauthAccounts"
          :key="account.id"
          type="button"
          class="card-option"
          :class="{ selected: wizard.credentials.accountId === account.id }"
          :disabled="selectingAccount"
          @click="chooseAccount(account.id)"
        >
          <h3>{{ account.name }}</h3>
          <p class="field-help" style="margin: 4px 0 0">{{ account.id }}</p>
        </button>
      </div>

      <template v-if="wizard.credentials.accountId">
        <div v-if="checks.length > 0" class="guide-card">
          <div class="permission-head">
            <h3>{{ t("authorize.checksTitle") }}</h3>
            <WinButton Style="SubtleButtonStyle" :IsEnabled="canVerify && !verifying" @Click="recheck">
              <span aria-hidden="true">⟳</span>{{ verifying ? t("authorize.verifying") : t("authorize.recheck") }}
            </WinButton>
          </div>
          <p class="field-help" style="margin-top: 0">{{ t("authorize.checksHelp") }}</p>
          <div class="permission-table-wrap">
            <table class="permission-table">
              <thead>
                <tr>
                  <th>{{ t("authorize.permissionRequirement") }}</th>
                  <th>{{ t("authorize.checkLabel") }}</th>
                  <th>{{ t("authorize.permissionStatus") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="check in checks" :key="check.id">
                  <td>
                    <span :class="`requirement-${check.requirement}`">{{ t(`authorize.requirements.${check.requirement}`) }}</span>
                  </td>
                  <td>
                    {{ localized(check.label, locale) }}
                    <p v-if="check.hint" class="group-list">{{ localized(check.hint, locale) }}</p>
                  </td>
                  <td>
                    <span v-if="hasAttempted" class="check-status" :title="detailOf(check.id)">
                      <span class="check-dot" :class="`check-dot-${statusOf(check.id)}`" aria-hidden="true" />
                      {{ t(`authorize.checkStatus.${statusOf(check.id)}`) }}
                    </span>
                    <span v-else class="check-status">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="verifyError" class="field-help tone-bad">{{ verifyError }}</p>
        </div>

        <template v-if="wizard.needsS3Keys">
          <div class="field">
            <label for="r2Key">
              {{ t("authorize.r2AccessKeyId") }}
              <span class="field-tag" :class="wizard.requiresS3Keys ? 'required' : 'optional'">
                {{ wizard.requiresS3Keys ? t("common.required") : t("common.optional") }}
              </span>
            </label>
            <input id="r2Key" v-model.trim="wizard.credentials.r2AccessKeyId" type="text" autocomplete="off" spellcheck="false" />
          </div>
          <div class="field">
            <label for="r2Secret">
              {{ t("authorize.r2SecretAccessKey") }}
              <span class="field-tag" :class="wizard.requiresS3Keys ? 'required' : 'optional'">
                {{ wizard.requiresS3Keys ? t("common.required") : t("common.optional") }}
              </span>
            </label>
            <input id="r2Secret" v-model.trim="wizard.credentials.r2SecretAccessKey" type="password" autocomplete="off" spellcheck="false" />
            <p class="field-help">{{ t("authorize.r2KeyHelp") }}</p>
            <p v-if="!s3PairComplete" class="field-help tone-bad">{{ t("authorize.r2KeysPairRequired") }}</p>
            <p v-if="hasAttempted && statusOf('r2Keys') !== 'pending'" class="field-help check-status">
              <span class="check-dot" :class="`check-dot-${statusOf('r2Keys')}`" aria-hidden="true" />
              {{ t(`authorize.checkStatus.${statusOf("r2Keys")}`) }}
              <template v-if="detailOf('r2Keys')">— {{ detailOf("r2Keys") }}</template>
            </p>
          </div>
        </template>

        <p v-if="hasAttempted && !verifying && !wizard.accountVerified" class="field-help tone-warn">
          {{ t("authorize.blocked") }}
        </p>
      </template>
    </template>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="goBack">{{ t("common.back") }}</WinButton>
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

.scope-codes {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  word-break: break-word;
}
</style>
