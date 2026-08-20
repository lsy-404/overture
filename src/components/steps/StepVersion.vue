<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { STEPS, useWizard } from "../../stores/wizard";
import { usePolicy } from "../../stores/policy";
import { parseSource, parseSourceLoose, sourceSlug, type SourceRef } from "../../../shared/package";
import { fetchReleases, fetchRepoMeta, type GithubRepoMeta } from "../../lib/github";
import { loadInstallConfig } from "../../lib/package/config";
import { loadDataPackage } from "../../lib/package/artifact";
import { analyzePackage } from "../../lib/analyze/analyze";
import { renderMarkdown } from "../../lib/markdown";
import { localized } from "../../lib/recipe/types";
import PackageReport from "../PackageReport.vue";
import { WinButton, WinCheckBox, WinInfoBar, WinProgressBar, WinProgressRing } from "../../vendor/winui";

const { t, locale } = useI18n();
const wizard = useWizard();
const policy = usePolicy();

// ---- source --------------------------------------------------------------

/** `?src=` that parsed but the operator's policy refuses. */
const rejected = ref<SourceRef | null>(null);
/** `?src=` that isn't an `owner/repo` at all. */
const malformed = ref("");

const manual = ref("");
const manualError = ref("");

const allowlist = computed(() => policy.policy.sources);
const freeInput = computed(() => policy.loaded && !policy.policy.allowlistEnabled);
const currentSlug = computed(() => (wizard.source ? sourceSlug(wizard.source) : ""));

// Changing the source invalidates anything downloaded from the previous one.
function selectSource(next: SourceRef, pinned = false) {
  if (currentSlug.value !== sourceSlug(next)) {
    wizard.releases = [];
    wizard.selectedTag = "";
    wizard.config = null;
    wizard.dataPackage = null;
    wizard.analysis = null;
  }
  wizard.source = next;
  wizard.sourcePinned = pinned;
  rejected.value = null;
  malformed.value = "";
  void listReleases();
}

function selectSlug(slug: string) {
  const parsed = parseSource(slug);
  if (parsed) selectSource(parsed);
}

function submitManual() {
  manualError.value = "";
  const parsed = parseSourceLoose(manual.value);
  if (!parsed) {
    manualError.value = t("version.manualInvalid");
    return;
  }
  if (!policy.allows(parsed)) {
    manualError.value = t("version.manualNotAllowed");
    return;
  }
  selectSource(parsed);
}

// ---- repository display metadata --------------------------------------------
// Purely decorative — the picker works off `allowlist`/`wizard.source` either
// way, this only replaces "owner/repo" with a project name and description
// once it loads. Never blocks selection, never surfaces its own errors.

const repoMeta = ref<Record<string, GithubRepoMeta | null>>({});
const metaRequested = new Set<string>();

async function loadRepoMeta(ref: SourceRef) {
  const slug = sourceSlug(ref);
  if (metaRequested.has(slug)) return;
  metaRequested.add(slug);
  repoMeta.value[slug] = await fetchRepoMeta(ref);
}

watch(
  allowlist,
  (slugs) => {
    for (const slug of slugs) {
      const parsed = parseSource(slug);
      if (parsed) void loadRepoMeta(parsed);
    }
  },
  { immediate: true },
);

watch(
  () => wizard.source,
  (src) => {
    if (src) void loadRepoMeta(src);
  },
  { immediate: true },
);

// ---- releases --------------------------------------------------------------

const listing = ref(false);
const listError = ref("");

async function listReleases() {
  const src = wizard.source;
  if (!src) return;
  listing.value = true;
  listError.value = "";
  try {
    wizard.releases = await fetchReleases(src);
    if (!wizard.releases.some((release) => release.tag_name === wizard.selectedTag)) {
      const stable = wizard.releases.find((release) => !release.prerelease);
      wizard.selectedTag = (stable || wizard.releases[0])?.tag_name || "";
    }
  } catch (e) {
    listError.value = e instanceof Error ? e.message : String(e);
  } finally {
    listing.value = false;
  }
}

const recommendedTag = computed(() => wizard.releases.find((release) => !release.prerelease)?.tag_name || "");

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return "";
  }
}

function selectRelease(tag: string) {
  wizard.selectedTag = tag;
  configError.value = "";
}

// ---- install configuration -------------------------------------------------

const configLoading = ref(false);
const configError = ref("");

/** The loaded configuration belongs to the release the user currently has selected. */
const ready = computed(() => !!wizard.config && wizard.config.tag === wizard.selectedTag);

// A release switched mid-download must not have the previous one's package —
// or, worse, the previous one's analysis — adopted on top of it. The package
// runs to megabytes, so the abandoned download is cancelled rather than left to
// finish into nothing.
let generation = 0;
let inflight: AbortController | null = null;

function supersede(): number {
  inflight?.abort();
  inflight = null;
  return ++generation;
}

async function loadConfig() {
  const src = wizard.source;
  const release = wizard.selectedRelease();
  if (!src || !release) return;
  const current = supersede();
  configLoading.value = true;
  configError.value = "";
  try {
    const loaded = await loadInstallConfig(src, release, locale.value);
    if (current !== generation) return;
    wizard.adoptConfig(loaded);
  } catch (e) {
    if (current !== generation) return;
    configError.value = e instanceof Error ? e.message : String(e);
    return;
  } finally {
    if (current === generation) configLoading.value = false;
  }
  await loadPackage(current);
}

// ---- data package & analysis -------------------------------------------------

const packageLoading = ref(false);
const packageError = ref("");
const packageProgress = ref(0);

/**
 * The package is fetched here rather than at deploy time so its recipe.js can be
 * read before the user is asked for anything. Its digest is checked against the
 * configuration on the way in, so a mismatch is caught while backing out still
 * costs nothing.
 */
async function loadPackage(current?: number) {
  const generationOf = current ?? supersede();
  const src = wizard.source;
  const release = wizard.selectedRelease();
  const recipe = wizard.recipe;
  if (!src || !release || !recipe) return;
  const controller = new AbortController();
  inflight = controller;
  packageLoading.value = true;
  packageError.value = "";
  packageProgress.value = 0;
  try {
    const loaded = await loadDataPackage(
      src,
      release,
      recipe,
      (bytes, total) => {
        if (generationOf === generation) packageProgress.value = total ? bytes / total : 0;
      },
      controller.signal,
    );
    if (generationOf !== generation) return;
    wizard.adoptPackage(loaded, analyzePackage(recipe, loaded.script));
  } catch (e) {
    if (generationOf !== generation) return;
    packageError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (inflight === controller) inflight = null;
    if (generationOf === generation) packageLoading.value = false;
  }
}

watch(
  () => wizard.selectedTag,
  (tag) => {
    if (tag && !(wizard.config && wizard.config.tag === tag)) void loadConfig();
  },
);

// ---- terms & licence -------------------------------------------------------

const hasTerms = computed(() => wizard.termsText.trim().length > 0);
const mustAccept = computed(() => hasTerms.value && wizard.recipe?.terms?.required === true);
const termsHtml = computed(() => renderMarkdown(wizard.termsText));
const licenseHtml = computed(() => renderMarkdown(wizard.licenseText));

const pane = ref<"terms" | "license">("terms");
watch(ready, (value) => {
  if (value) pane.value = hasTerms.value ? "terms" : "license";
});

const termsPane = ref<HTMLElement | null>(null);
const termsRead = ref(false);

function checkTermsRead() {
  const element = termsPane.value;
  if (!element) return;
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 4) termsRead.value = true;
}

watch(ready, (value) => {
  if (!value) return;
  termsRead.value = !hasTerms.value;
  wizard.termsAccepted = false;
  if (hasTerms.value) void nextTick(checkTermsRead);
});

// The analysis is the point of this step now: the package has to be in hand and
// read before the wizard will ask the user for a credential.
const canContinue = computed(() => ready.value && !!wizard.analysis && (!mustAccept.value || wizard.termsAccepted));

// ---- bootstrap --------------------------------------------------------------

onMounted(async () => {
  await policy.load();
  if (wizard.source) {
    if (wizard.releases.length === 0) void listReleases();
    return;
  }
  const raw = (new URLSearchParams(location.search).get("src") || "").trim();
  if (!raw) return;
  const parsed = parseSource(raw);
  if (!parsed) {
    malformed.value = raw;
    return;
  }
  if (!policy.allows(parsed)) {
    rejected.value = parsed;
    return;
  }
  selectSource(parsed, true);
});
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("version.title") }}</h1>
    <p class="step-subtitle">{{ t("version.subtitle") }}</p>

    <div v-if="!policy.loaded" class="inline-status">
      <WinProgressRing :Width="20" :Height="20" :IsActive="true" />
      <span>{{ t("version.loadingPolicy") }}</span>
    </div>

    <template v-else>
      <WinInfoBar v-if="malformed" :IsOpen="true" Severity="Error" :IsClosable="false" :IsIconVisible="false">
        {{ t("version.malformedSrc", { value: malformed }) }}
      </WinInfoBar>

      <WinInfoBar v-if="rejected" :IsOpen="true" Severity="Error" :IsClosable="false" :IsIconVisible="false">
        <strong>{{ t("version.rejectedTitle") }}</strong>
        <p style="margin: 6px 0 0">{{ t("version.rejectedBody", { source: sourceSlug(rejected) }) }}</p>
      </WinInfoBar>

      <!-- A `?src=` the policy accepts needs no picker: the link already named
           the one repository this run deploys from. Plain text, not a card —
           there is nothing here to choose between. -->
      <div v-if="wizard.sourcePinned && wizard.source" class="pinned-source">
        <h3>{{ repoMeta[currentSlug]?.name || currentSlug }}</h3>
        <p>{{ repoMeta[currentSlug]?.description || t("version.githubRepo") }}</p>
        <p class="field-help" style="margin: 4px 0 0">{{ currentSlug }}</p>
      </div>

      <template v-else>
        <p v-if="allowlist.length > 0" class="field-help">{{ t("version.allowlistIntro") }}</p>
        <button
          v-for="slug in allowlist"
          :key="slug"
          type="button"
          class="card-option"
          :class="{ selected: currentSlug === slug }"
          @click="selectSlug(slug)"
        >
          <h3>{{ repoMeta[slug]?.name || slug }}</h3>
          <p>{{ repoMeta[slug]?.description || t("version.githubRepo") }}</p>
          <p class="field-help" style="margin: 4px 0 0">{{ slug }}</p>
        </button>

        <WinInfoBar
          v-if="policy.policy.allowlistEnabled && allowlist.length === 0"
          :IsOpen="true"
          Severity="Warning"
          :IsClosable="false"
          :IsIconVisible="false"
        >
          {{ t("version.allowlistEmpty") }}
        </WinInfoBar>

        <template v-if="freeInput">
          <WinInfoBar :IsOpen="true" Severity="Warning" :IsClosable="false" :IsIconVisible="false">
            {{ t("version.allowlistOff") }}
          </WinInfoBar>
          <div class="field" style="margin-top: 16px">
            <label for="manualSource">{{ t("version.manualLabel") }}</label>
            <input
              id="manualSource"
              v-model.trim="manual"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="https://github.com/owner/repo"
              @keyup.enter="submitManual"
            />
            <p class="field-help">{{ t("version.manualHelp") }}</p>
            <p v-if="manualError" class="field-help tone-bad">{{ manualError }}</p>
          </div>
          <WinButton @Click="submitManual">{{ t("version.manualUse") }}</WinButton>
        </template>
      </template>

      <template v-if="wizard.source">
        <h3 class="section-heading">{{ t("version.releaseHeading") }}</h3>

        <div v-if="listing" class="inline-status">
          <WinProgressRing :Width="20" :Height="20" :IsActive="true" />
          <span>{{ t("common.loading") }}</span>
        </div>
        <WinInfoBar v-else-if="listError" :IsOpen="true" Severity="Error" :IsClosable="false" :IsIconVisible="false">{{ listError }}</WinInfoBar>
        <WinInfoBar v-else-if="wizard.releases.length === 0" :IsOpen="true" Severity="Warning" :IsClosable="false" :IsIconVisible="false">
          {{ t("version.noneEligible") }}
        </WinInfoBar>

        <template v-else>
          <button
            v-for="release in wizard.releases"
            :key="release.tag_name || ''"
            type="button"
            class="card-option"
            :class="{ selected: wizard.selectedTag === release.tag_name }"
            @click="selectRelease(release.tag_name || '')"
          >
            <h3>
              {{ release.name || release.tag_name }}
              <span v-if="release.tag_name === recommendedTag" class="field-tag recommended">{{ t("version.recommended") }}</span>
              <span v-if="release.prerelease" class="field-tag optional">{{ t("version.prerelease") }}</span>
            </h3>
            <p>{{ release.tag_name }} · {{ formatDate(release.published_at) }}</p>
          </button>
          <WinButton style="margin-top: 8px" @Click="listReleases">{{ t("version.reload") }}</WinButton>
        </template>
      </template>

      <template v-if="wizard.selectedTag">
        <h3 class="section-heading">{{ t("version.agreementHeading") }}</h3>

        <div v-if="configLoading" class="inline-status">
          <WinProgressRing :Width="20" :Height="20" :IsActive="true" />
          <span>{{ t("common.loading") }}</span>
        </div>
        <WinInfoBar v-else-if="configError" :IsOpen="true" Severity="Error" :IsClosable="false" :IsIconVisible="false">
          <strong>{{ t("version.configFailed") }}</strong>
          <p style="margin: 6px 0 0">{{ configError }}</p>
          <WinButton style="margin-top: 10px" @Click="loadConfig">{{ t("common.retry") }}</WinButton>
        </WinInfoBar>

        <template v-else-if="ready && wizard.recipe">
          <p class="field-help">
            <strong>{{ wizard.recipe.name }}</strong> {{ wizard.recipe.version }} —
            {{ localized(wizard.recipe.summary, locale) }}
          </p>

          <div v-if="packageLoading" class="inline-status analysis-status">
            <WinProgressRing :Width="20" :Height="20" :IsActive="true" />
            <span>{{ t("analyze.loading") }}</span>
            <WinProgressBar v-if="packageProgress > 0" :Value="packageProgress * 100" style="flex: 1 1 120px" />
          </div>
          <WinInfoBar v-else-if="packageError" :IsOpen="true" Severity="Error" :IsClosable="false" :IsIconVisible="false">
            <strong>{{ t("analyze.failed") }}</strong>
            <p style="margin: 6px 0 0">{{ packageError }}</p>
            <WinButton style="margin-top: 10px" @Click="loadPackage()">{{ t("common.retry") }}</WinButton>
          </WinInfoBar>
          <PackageReport v-else-if="wizard.analysis" :analysis="wizard.analysis" />

          <div class="pane-tabs">
            <button v-if="hasTerms" type="button" class="pane-tab" :class="{ active: pane === 'terms' }" @click="pane = 'terms'">
              {{ t("version.termsTab") }}
            </button>
            <button type="button" class="pane-tab" :class="{ active: pane === 'license' }" @click="pane = 'license'">
              {{ t("version.licenseTab", { id: wizard.recipe.license.id }) }}
            </button>
          </div>

          <div
            v-show="pane === 'terms' && hasTerms"
            ref="termsPane"
            class="text-pane markdown-pane"
            tabindex="0"
            @scroll="checkTermsRead"
            v-html="termsHtml"
          ></div>
          <div v-show="pane === 'license'" class="text-pane" tabindex="0">
            <div v-if="wizard.licenseText" class="markdown-pane" v-html="licenseHtml"></div>
            <p v-else>{{ t("version.licenseMissing") }}</p>
          </div>

          <div v-if="mustAccept" class="accept-row">
            <WinCheckBox v-model="wizard.termsAccepted" :IsEnabled="termsRead">
              <span><span class="required-star" aria-hidden="true">*</span>{{ t("version.accept") }}</span>
            </WinCheckBox>
            <span v-if="!termsRead" class="field-help accept-hint">{{ t("version.scrollToEnd") }}</span>
          </div>
          <p v-else-if="hasTerms" class="field-help accept-hint">{{ t("version.acceptOptional") }}</p>
          <p v-else class="field-help accept-hint">{{ t("version.noTerms") }}</p>
        </template>
      </template>

      <p class="field-help source-footer">
        <a href="#" @click.prevent="policy.show('policy')">{{ t("version.policyLink") }}</a>
      </p>
    </template>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="wizard.goTo(STEPS.tos)">{{ t("common.back") }}</WinButton>
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="canContinue" @Click="wizard.goTo(STEPS.credentials)">
          {{ t("common.next") }}
        </WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pinned-source {
  margin-bottom: 12px;
}

.pinned-source h3 {
  font-size: 1rem;
  margin-bottom: 4px;
  color: var(--text-primary);
}

.pinned-source p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.source-footer {
  margin-top: 24px;
}

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

.analysis-status {
  flex-wrap: wrap;
  margin: 16px 0;
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
