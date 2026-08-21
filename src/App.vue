<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref, watch, type Component } from "vue";
import { usePolicy } from "./stores/policy";
import { STEPS, TOTAL_STEPS, useWizard } from "./stores/wizard";
import { revokeOAuthSession } from "./lib/relay";
import WizardShell from "./components/WizardShell.vue";
import PolicyPage from "./components/PolicyPage.vue";
import StepTos from "./components/steps/StepTos.vue";
import StepRepository from "./components/steps/StepRepository.vue";
import StepLicense from "./components/steps/StepLicense.vue";
import StepAuthMethod from "./components/steps/StepAuthMethod.vue";
import StepAuthorize from "./components/steps/StepAuthorize.vue";
import StepTarget from "./components/steps/StepTarget.vue";
import StepConfirm from "./components/steps/StepConfirm.vue";
import StepDeploy from "./components/steps/StepDeploy.vue";
import StepDone from "./components/steps/StepDone.vue";

const wizard = useWizard();
const policy = usePolicy();

const PAGES: Record<number, Component> = {
  [STEPS.tos]: StepTos,
  [STEPS.repository]: StepRepository,
  [STEPS.license]: StepLicense,
  [STEPS.authMethod]: StepAuthMethod,
  [STEPS.authorize]: StepAuthorize,
  [STEPS.target]: StepTarget,
  [STEPS.confirm]: StepConfirm,
  [STEPS.deploy]: StepDeploy,
  [STEPS.done]: StepDone,
};

// A session nobody explicitly signed out of is still cleaned up here: closing
// or navigating away from the tab is the one moment `sendBeacon` would be the
// usual tool, except it cannot carry the `Overture-Relay` header this route
// requires — `keepalive` is what lets the request survive the unload anyway.
window.addEventListener("pagehide", () => {
  if (wizard.authorized) void revokeOAuthSession({ keepalive: true });
});

const current = computed(() => (policy.view === "policy" ? PolicyPage : PAGES[wizard.step] || StepTos));
const pageKey = computed(() => (policy.view === "policy" ? "policy" : `step-${wizard.step}`));
const shellStep = computed(() => (policy.view === "policy" ? 0 : Math.min(wizard.step, TOTAL_STEPS)));

const transitionName = ref("slide-left");
watch(
  () => wizard.step,
  (next, previous) => {
    transitionName.value = next >= previous ? "slide-left" : "slide-right";
  },
);
</script>

<template>
  <WizardShell :step="shellStep" :total="TOTAL_STEPS">
    <Transition :name="transitionName">
      <component :is="current" :key="pageKey" />
    </Transition>
  </WizardShell>
</template>
