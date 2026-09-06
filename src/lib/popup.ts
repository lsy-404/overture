// SPDX-License-Identifier: AGPL-3.0-or-later

export interface PopupOptions {
  width: number;
  height: number;
  keepOpener: boolean;
}

function popupFeatures({ width, height }: PopupOptions): string {
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

/** Opens a popup while the browser still considers the click a user gesture. */
export function openPopup(url: string, name: string, options: PopupOptions): Window | null {
  let popup: Window | null;
  try {
    popup = options.keepOpener
      ? window.open(url, name, popupFeatures(options))
      : window.open("", "_blank", popupFeatures(options));
  } catch {
    return null;
  }
  if (!popup || options.keepOpener) return popup;

  try {
    popup.opener = null;
    const referrer = popup.document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    popup.document.head.append(referrer);
    popup.location.href = url;
    return popup;
  } catch {
    try {
      popup.close();
    } catch {
      // Closing a rejected popup is best effort.
    }
    return null;
  }
}
