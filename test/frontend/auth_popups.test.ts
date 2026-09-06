// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { openPopup } from "../../src/lib/popup";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const events: string[] = [];
let blocked = false;
let failOpen = false;
let failNavigation = false;
let openedWith: string[] = [];
const opener = {};
let currentOpener: unknown = opener;
const navigationLink = {
  href: "", target: "", rel: "", referrerPolicy: "",
  click() {
    assert.equal(currentOpener, null, "Opener is isolated before the link is followed");
    assert.equal(this.referrerPolicy, "no-referrer");
    assert.equal(this.rel, "noreferrer");
    assert.equal(this.target, "_self");
    if (failNavigation) throw new Error("Navigation denied");
    events.push(`navigate:${this.href}`);
  },
};
const popup = {
  get opener() { return currentOpener; },
  set opener(value: unknown) { currentOpener = value; events.push("opener"); },
  document: {
    createElement: (name: string) => { assert.equal(name, "a"); return navigationLink; },
    body: { append(link: typeof navigationLink) {
      assert.equal(link, navigationLink);
      events.push("append");
    } },
  },
  focus() { events.push("focus"); },
  close() { events.push("close"); },
};

Object.defineProperty(globalThis, "window", { configurable: true, value: {
  screenX: 50, screenY: 20, outerWidth: 1200, outerHeight: 1000,
  innerWidth: 1200, innerHeight: 1000,
  screen: { availWidth: 1920, availHeight: 1080 },
  open(url: string, name: string, features: string) {
    openedWith = [url, name, features];
    events.push("open");
    if (failOpen) throw new Error("Popup denied");
    return blocked ? null : popup;
  },
} });

try {
  const oauth = openPopup("/oauth/authorize?scope=account.read&pkg=probe", "overture-oauth", {
    width: 520, height: 720, keepOpener: true,
  });
  assert.equal(oauth, popup);
  assert.equal(openedWith[1], "overture-oauth");
  assert.match(openedWith[2], /(?:^|,)popup=(?:yes|true|1)(?:,|$)/);
  assert.match(openedWith[2], /(?:^|,)width=520(?:,|$)/);
  assert.match(openedWith[2], /(?:^|,)height=720(?:,|$)/);
  assert.equal(currentOpener, opener, "OAuth keeps its callback channel");
  assert.equal(navigationLink.href, "");
  assert.ok(!openedWith[2].includes("noopener"));

  events.length = 0;
  const token = openPopup("https://example.test/token?name=Demo", "overture-api-token", {
    width: 760, height: 820, keepOpener: false,
  });
  assert.equal(token, popup);
  assert.equal(openedWith[0], "", "A fresh same-origin blank window is isolated before navigation");
  assert.equal(openedWith[1], "_blank", "An old cross-origin token window cannot be overwritten by name");
  assert.equal(currentOpener, null);
  const navigation = events.indexOf("navigate:https://example.test/token?name=Demo");
  assert.ok(navigation > events.indexOf("opener"));
  assert.ok(navigation > events.indexOf("append"));

  events.length = 0;
  blocked = true;
  assert.equal(openPopup("/probe", "probe", { width: 520, height: 720, keepOpener: true }), null);
  assert.deepEqual(events, ["open"], "Blocked windows are not dereferenced");

  blocked = false;
  failOpen = true;
  assert.equal(openPopup("/probe", "probe", { width: 520, height: 720, keepOpener: true }), null);
  failOpen = false;

  events.length = 0;
  blocked = false;
  failNavigation = true;
  assert.equal(openPopup("/probe", "probe", { width: 760, height: 820, keepOpener: false }), null);
  assert.ok(events.includes("close"), "Failed setup closes its blank popup");
  console.log("PASS OAuth callback channel, explicit popup, isolated token navigation, blocked and failed windows");
} finally {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
}
