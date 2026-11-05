// Small DOM and messaging helpers for the extension pages.

import type { GatewayMethodName, GatewayMethods } from "@anymcp/shared";
import type { PanelMessage, Reply } from "../messages.js";

export type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "open" || k === "selected" || k === "textContent") {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const $ = (id: string) => document.getElementById(id)!;

export function put(el: Element, ...children: (Child | Child[])[]): void {
  el.replaceChildren(...children.flat().filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
}

export async function bg<T>(msg: PanelMessage): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined;
  if (!r) throw new Error("The extension didn't answer. Try reopening this window.");
  if (!r.ok) throw new Error(r.error);
  return r.result;
}

export function gw<M extends GatewayMethodName>(method: M, params: GatewayMethods[M]["params"]): Promise<GatewayMethods[M]["result"]> {
  return bg({ type: "gateway", method, params });
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
