<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { verifyAccount, type CredentialCheck } from "../../lib/cf/verify";
import { fetchOAuthSession, oauthAuthorizeUrl, selectOAuthAccount, submitAuthToken } from "../../lib/relay";
import { localized } from "../../lib/recipe/types";
import { buildTokenLinkUrl, describePermissions, mergeDeclaredPermissions, mergeTokenPermissions, preflightPermissionsForChecks } from "../../lib/cf/tokenLink";
import { openPopup } from "../../lib/popup";
import { WinButton, WinInfoBar } from "../../vendor/winui";

const { t, locale } = useI18n();
const wizard = useWizard();

const titleKey = computed(() => (wizard.authMode === "auto" ? "authorize.auto.title" : "authorize.title"));
const subtitleKey = computed(() => (wizard.authMode === "auto" ? "authorize.auto.subtitle" : "authorize.subtitle"));

/** The long-lived token this app wants, when the recipe declares one. */
const cfApiTokenSecret = computed(() => wizard.recipe?.hostSecrets?.find((secret) => secret.source === "cfApiToken"));
const tokenPlaceholder = computed(() =>
  cfApiTokenSecret.value?.placeholder ? localized(cfApiTokenSecret.value.placeholder, locale.value) : t("authorize.auto.placeholder"),
);
// The session cookie authenticates deployment calls but cannot restore the
// app-owned token after a tab reload unless this tab still has it. Never show
// the stored value; request a fresh paste before proceeding instead.
const needsRequiredAppToken = computed(() => wizard.requiresAutoAppToken && !wizard.credentials.cfApiToken.trim());
const checks = computed(() => wizard.recipe?.checks ?? []);
const turnstiles = computed(() => wizard.recipe?.turnstiles ?? []);
const manualPaidChecks = computed(() =>
  wizard.authMode === "oauth" ? checks.value.filter((check) => check.expect === "paid") : [],
);
const manualPaidCheckIds = computed(() => new Set(manualPaidChecks.value.map((check) => check.id)));
const manualChecksConfirmed = computed(() =>
  manualPaidChecks.value.every((check) => wizard.isManualCheckConfirmed(check.id)),
);
const BILLING_URL = "https://dash.cloudflare.com/?to=/:account/billing";

function requiresManualConfirmation(check: { id: string }): boolean {
  return manualPaidCheckIds.value.has(check.id);
}

function setManualConfirmation(checkId: string, event: Event) {
  wizard.confirmManualCheck(checkId, (event.target as HTMLInputElement).checked);
}

const TURNSTILE_PERMISSION = {
  key: "challenge_widgets",
  type: "edit",
  requirement: "required",
} as const;

/** Every permission the app's token needs, with its display name and danger flag. */
const permissionRows = computed(() => describePermissions(mergeDeclaredPermissions([
  ...(cfApiTokenSecret.value?.permissions ?? []),
  ...(turnstiles.value.length > 0 ? [TURNSTILE_PERMISSION] : []),
])));

// Optional permissions the user has chosen to leave out. They stay in the list
// but drop out of the pre-filled link, so the token the user creates asks for
// only what they kept.
const excludedKeys = ref<Set<string>>(new Set());
function isOptional(row: { requirement?: string }): boolean {
  return row.requirement === "optional";
}
function togglePermission(key: string): void {
  const next = new Set(excludedKeys.value);
  next.has(key) ? next.delete(key) : next.add(key);
  excludedKeys.value = next;
}

const includedPermissions = computed(() =>
  [
    ...(cfApiTokenSecret.value?.permissions ?? []).filter((p) => !(p.requirement === "optional" && excludedKeys.value.has(p.key))),
    ...(turnstiles.value.length > 0 ? [TURNSTILE_PERMISSION] : []),
  ],
);
const preflightPermissions = computed(() => preflightPermissionsForChecks(checks.value));
const excludedPreflightKeys = ref<Set<string>>(new Set());
function togglePreflightPermission(key: string) {
  const next = new Set(excludedPreflightKeys.value);
  next.has(key) ? next.delete(key) : next.add(key);
  excludedPreflightKeys.value = next;
}
const includedPreflightPermissions = computed(() =>
  preflightPermissions.value.filter((permission) => permission.requirement !== "optional" || !excludedPreflightKeys.value.has(permission.key)),
);
const preflightPermissionRows = computed(() =>
  preflightPermissions.value.map((permission) => ({
    ...describePermissions([permission])[0],
    checks: permission.checks.map((check) => localized(check.label, locale.value)).join(" · "),
  })),
);

// Overture's own read verifies the token's resulting grant; preflight reads
// are derived separately from the requested GET endpoints above.
const OVERTURE_TOKEN_PERM = { key: "account_api_tokens", type: "read" } as const;
const tokenPermissions = computed(() => mergeTokenPermissions(
  includedPermissions.value,
  includedPreflightPermissions.value,
  [OVERTURE_TOKEN_PERM],
));
const dangerPermissions = computed(() => describePermissions(tokenPermissions.value).filter((row) => row.danger));

/** The account-token creation link includes the app, every kept pre-check, and Overture's disclosed read. */
const tokenLinkUrl = computed(() => buildTokenLinkUrl(tokenPermissions.value, wizard.recipe?.name));

function goBack() {
  wizard.goTo(wizard.hasAuthChoice ? STEPS.authMethod : STEPS.license);
}

// ---- sign-in popup (oauth mode) --------------------------------------------

const signingIn = ref(false);
const popupError = ref("");
let popupRef: Window | null = null;
let popupWatch: ReturnType<typeof setInterval> | undefined;
let tokenPopupRef: Window | null = null;

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
  const popup = openPopup(url, "overture-oauth", { width: 520, height: 720, keepOpener: true });
  if (!popup) {
    popupError.value = t("authorize.popupBlocked");
    return;
  }
  popupRef = popup;
  signingIn.value = true;
  watchPopup(popup);
}

function startTokenCreation() {
  popupError.value = "";
  if (tokenPopupRef) {
    try {
      if (!tokenPopupRef.closed) {
        tokenPopupRef.focus();
        return;
      }
      tokenPopupRef = null;
    } catch {
      // Do not risk navigating a popup that might show a one-time token.
      return;
    }
  }

  tokenPopupRef = openPopup(tokenLinkUrl.value, "overture-api-token", { width: 760, height: 820, keepOpener: false });
  if (!tokenPopupRef) popupError.value = t("authorize.auto.popupBlocked");
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
  tokenPopupRef = null;
});

// ---- pasted token (auto mode) -----------------------------------------------
// The value lives only in this local ref, never kept once it has been posted:
// it is sent to the relay to seal the deploy session, and — since this same
// token is also the app's own long-lived credential when the recipe declares
// one — copied into the wizard's in-memory credentials. Either way it is gone
// from this component's own state the moment the request settles.

const pasteToken = ref("");
const submitting = ref(false);
const submitError = ref("");

const canSubmitToken = computed(() => pasteToken.value.trim().length > 0 && !submitting.value);

async function submitToken() {
  const recipe = wizard.recipe;
  if (!recipe || wizard.authMode !== "auto") return;
  const value = pasteToken.value.trim();
  if (!value) return;
  submitting.value = true;
  submitError.value = "";
  popupError.value = "";
  try {
    const session = await submitAuthToken(value, "auto", recipe.package.sha256);
    wizard.applyOAuthSession(session);
    // This one pasted token covers both deploy and — if the app needs one —
    // its own long-lived credential afterward, so the value the user just
    // typed is what gets handed to the app later.
    wizard.credentials.cfApiToken = value;
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

function statusOf(key: string): CredentialCheck["status"] {
  return statuses[key]?.status ?? "pending";
}

function detailOf(key: string): string {
  return statuses[key]?.detail || "";
}

// A feature that simply isn't turned on is not a failure — an optional one the
// app works without, and a required one the user just has to switch on (a check
// that carries an actionUrl points them straight at where). Either reads as
// "not enabled" with the fix to hand, not the red "check failed" of a genuine
// error.
function effectiveStatus(check: { id: string; requirement: string; actionUrl?: string }): string {
  const status = statusOf(check.id);
  if ((check.requirement === "optional" || check.actionUrl) && (status === "missing" || status === "error")) return "notEnabled";
  return status;
}

const s3PairComplete = computed(() => {
  const key = wizard.credentials.r2AccessKeyId.trim();
  const secret = wizard.credentials.r2SecretAccessKey.trim();
  if (wizard.requiresS3Keys) return !!key && !!secret;
  return (!key && !secret) || (!!key && !!secret);
});

const canVerify = computed(() => wizard.sessionMatchesPackage && !!wizard.credentials.accountId);
const canContinue = computed(() =>
  canVerify.value && wizard.accountVerified && manualChecksConfirmed.value && s3PairComplete.value && !needsRequiredAppToken.value,
);

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

watch(
  () => wizard.credentials.accountId,
  () => wizard.clearManualCheckConfirmations(),
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
    const outcome = await verifyAccount(
      { ...wizard.credentials },
      recipe,
      (check) => {
        if (current !== generation) return;
        statuses[check.key] = check;
      },
      { manualConfirmationIds: manualPaidCheckIds.value },
    );
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

    <div v-if="wizard.authMode === 'oauth'" class="guide-card">
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

    <template v-if="!wizard.sessionMatchesPackage || needsRequiredAppToken">
      <template v-if="wizard.authMode === 'oauth'">
        <WinButton Style="AccentButtonStyle" :IsEnabled="!signingIn" @Click="startSignIn">
          {{ signingIn ? t("authorize.signingIn") : t("authorize.signInButton") }}
        </WinButton>
        <p v-if="popupError" class="field-help tone-bad">{{ popupError }}</p>
      </template>

      <template v-else-if="wizard.authMode === 'auto'">
        <div v-if="permissionRows.length > 0" class="guide-card">
          <h3>{{ t("authorize.auto.requirementsTitle") }}</h3>
          <p class="field-help" style="margin-top: 0">{{ t("authorize.auto.requirementsIntro") }}</p>
          <ul class="plain-list">
            <li v-for="permission in permissionRows" :key="permission.key">
              <label v-if="isOptional(permission)" class="perm-check">
                <input type="checkbox" :checked="!excludedKeys.has(permission.key)" @change="togglePermission(permission.key)" />
                <span class="field-tag optional">{{ t("authorize.requirements.optional") }}</span>
                <span>{{ permission.name }}</span>
              </label>
              <template v-else>
                <span class="field-tag required">{{ t("authorize.requirements.required") }}</span>
                {{ permission.name }}
              </template>
              <p v-if="permission.scenario" class="field-help" style="margin: 2px 0 0">{{ localized(permission.scenario, locale) }}</p>
            </li>
            <li>
              <span class="field-tag required">{{ t("authorize.requirements.required") }}</span>
              {{ t("authorize.auto.overtureReadName") }}
              <p class="field-help" style="margin: 2px 0 0">{{ t("authorize.auto.overtureReadNote") }}</p>
            </li>
          </ul>
        </div>

        <div v-if="preflightPermissionRows.length > 0" class="guide-card">
          <h3>{{ t("authorize.auto.checkPermissionsTitle") }}</h3>
          <p class="field-help" style="margin-top: 0">{{ t("authorize.auto.checkPermissionsIntro") }}</p>
          <ul class="plain-list">
            <li v-for="permission in preflightPermissionRows" :key="permission.key">
              <label v-if="isOptional(permission)" class="perm-check">
                <input type="checkbox" :checked="!excludedPreflightKeys.has(permission.key)" @change="togglePreflightPermission(permission.key)" />
                <span class="field-tag optional">{{ t("authorize.requirements.optional") }}</span>
                <span>{{ permission.name }}</span>
              </label>
              <template v-else>
                <span :class="`field-tag ${permission.requirement ?? 'required'}`">{{ t(`authorize.requirements.${permission.requirement ?? 'required'}`) }}</span>
                {{ permission.name }}
              </template>
              <p class="field-help" style="margin: 2px 0 0">{{ t("authorize.auto.checkPermissionNote", { checks: permission.checks }) }}</p>
            </li>
          </ul>
        </div>

        <WinInfoBar v-if="dangerPermissions.length > 0" :IsOpen="true" Severity="Error" :IsClosable="false" :IsIconVisible="false">
          <strong>{{ t("authorize.auto.dangerTitle") }}</strong>
          <p style="margin: 6px 0 0">{{ t("authorize.auto.dangerIntro") }}</p>
          <ul style="margin: 6px 0 0; padding-left: 20px">
            <li v-for="permission in dangerPermissions" :key="permission.key">{{ permission.name }}</li>
          </ul>
        </WinInfoBar>

        <WinButton Style="AccentButtonStyle" MinHeight="44" Padding="20,10" Margin="0,8,0,4" @Click="startTokenCreation">
          {{ t("authorize.auto.tokenLinkLabel") }}
        </WinButton>
        <p v-if="popupError" class="field-help tone-bad">{{ popupError }}</p>
        <div class="field">
          <label for="autoToken">{{ t("authorize.auto.tokenLabel") }}</label>
          <input
            id="autoToken"
            v-model="pasteToken"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="tokenPlaceholder"
          />
        </div>
        <p v-if="needsRequiredAppToken && wizard.sessionMatchesPackage" class="field-help tone-warn">{{ t("authorize.auto.tokenRequired") }}</p>
        <WinButton Style="AccentButtonStyle" :IsEnabled="canSubmitToken" @Click="submitToken">
          {{ submitting ? t("authorize.auto.submitting") : t("authorize.auto.submit") }}
        </WinButton>
        <p v-if="submitError" class="field-help tone-bad">{{ submitError }}</p>
      </template>
    </template>

    <template v-else>
      <div class="guide-card">
        <h3>{{ t("authorize.grantedTitle") }}</h3>
        <ul v-if="wizard.oauthScope.length > 0" class="plain-list" style="margin-top: 0">
          <li v-for="grant in wizard.oauthScope" :key="grant">{{ grant }}</li>
        </ul>
        <p v-else class="field-help" style="margin-top: 0">{{ t("authorize.grantedUnknown") }}</p>
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
                    <p v-if="requiresManualConfirmation(check)" class="field-help">{{ t("authorize.paidManualHelp") }}</p>
                    <a
                      v-if="check.actionUrl && hasAttempted && effectiveStatus(check) === 'notEnabled'"
                      :href="check.actionUrl"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="field-help"
                    >{{ t("authorize.checkActionOpen") }}</a>
                  </td>
                  <td>
                    <template v-if="requiresManualConfirmation(check)">
                      <span class="check-status">
                        <span class="check-dot" :class="wizard.isManualCheckConfirmed(check.id) ? 'check-dot-ok' : 'check-dot-manual'" aria-hidden="true" />
                        {{ wizard.isManualCheckConfirmed(check.id) ? t("authorize.checkStatus.manualConfirmed") : t("authorize.checkStatus.manual") }}
                      </span>
                      <a :href="check.actionUrl || BILLING_URL" target="_blank" rel="noopener noreferrer" class="field-help">
                        {{ t("authorize.paidManualOpen") }}
                      </a>
                      <label class="perm-check field-help">
                        <input type="checkbox" :checked="wizard.isManualCheckConfirmed(check.id)" @change="setManualConfirmation(check.id, $event)" />
                        <span>{{ t("authorize.paidManualConfirm") }}</span>
                      </label>
                    </template>
                    <span v-else-if="hasAttempted" class="check-status" :title="detailOf(check.id)">
                      <span class="check-dot" :class="`check-dot-${effectiveStatus(check)}`" aria-hidden="true" />
                      {{ t(`authorize.checkStatus.${effectiveStatus(check)}`) }}
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
