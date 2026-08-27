import type { InjectionKey, Ref } from "vue";

export const SHELL_SCROLL_AREA: InjectionKey<Ref<HTMLElement | null>> = Symbol("shell-scroll-area");
