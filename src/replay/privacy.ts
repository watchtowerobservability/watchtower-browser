import { CANVAS_OPTS, canvasAllowed } from "./canvas";
import type { MaskLevel, ReplayConfig, RrEvent } from "./config";

/** Every non-space character becomes `*`, so length class survives but content does not. */
export const maskText = (s: string): string => s.replace(/\S/g, "*");
const maskInput = (s: string): string => "*".repeat(s.length);

/**
 * The only place the rrweb `record()` options are built. Hostile or sloppy config (e.g. `maskAllInputs: false`)
 * has no path in: inputs are always masked and the block/mask classes are fixed.
 */
export function buildRecordOptions(cfg: ReplayConfig, level: MaskLevel): Record<string, unknown> {
  const extra = (s?: string): string => (s ? `, ${s}` : "");
  const strict = level === "strict";
  const canvas = canvasAllowed(cfg.recordCanvas, level);
  return {
    maskAllInputs: true,
    maskInputOptions: {
      password: true, email: true, tel: true, text: true, textarea: true,
      select: true, number: true, search: true, url: true,
    },
    maskInputFn: maskInput,
    blockClass: "wt-block",
    blockSelector: `[data-wt-block]${extra(cfg.blockSelector)}`,
    maskTextClass: "wt-mask",
    maskTextSelector: strict ? "*" : `[data-wt-mask]${extra(cfg.maskTextSelector)}`,
    maskTextFn: (text: string, el?: Element | null): string => {
      // strict honours only the explicit attribute; unmask never reaches inputs (maskInputFn is unconditional)
      const keep = strict ? "[data-wt-unmask]" : cfg.unmaskSelector;
      return keep && el?.closest?.(keep) ? text : maskText(text);
    },
    recordCanvas: canvas,
    ...(canvas ? CANVAS_OPTS : {}),
    recordCrossOriginIframes: cfg.recordCrossOriginIframes === true,
    collectFonts: cfg.collectFonts === true,
    checkoutEveryNms: cfg.checkoutEveryNms,
  };
}

/** Elements the page exempts from text masking, so reviewers can audit the allow-list. */
export function unmaskReport(root: ParentNode, cfg: ReplayConfig): { selector: string; count: number }[] {
  const sels = ["[data-wt-unmask]", ...(cfg.unmaskSelector ? [cfg.unmaskSelector] : [])];
  return sels
    .map((selector) => ({ selector, count: root.querySelectorAll(selector).length }))
    .filter((r) => r.count > 0);
}

/** Walks rrweb nodes, blanking values of password/card/OTP inputs. Keeps the sensitive node ids across events. */
export class Sanitizer {
  private ids = new Set<number>();
  scrubbed = 0;

  private sensitive(n: any): boolean {
    if (n?.type !== 2 || String(n.tagName).toLowerCase() !== "input") return false;
    const a = n.attributes ?? {};
    const t = String(a.type ?? "").toLowerCase();
    const ac = String(a.autocomplete ?? "").toLowerCase();
    return t === "password" || ac.startsWith("cc-") || ac === "one-time-code";
  }

  private walk(n: any): void {
    if (!n || typeof n !== "object") return;
    if (this.sensitive(n)) {
      this.ids.add(n.id);
      if (n.attributes && "value" in n.attributes) {
        n.attributes.value = "*";
        this.scrubbed++;
      }
    }
    if (Array.isArray(n.childNodes)) n.childNodes.forEach((c: unknown) => this.walk(c));
  }

  /** Mutates and returns the event. */
  apply(e: RrEvent): RrEvent {
    const d = e.data;
    if (e.type === 2) this.walk(d?.node);
    else if (e.type === 3 && d) {
      if (d.source === 0) {
        (d.adds ?? []).forEach((a: any) => this.walk(a?.node));
        (d.attributes ?? []).forEach((a: any) => {
          if (this.ids.has(a?.id) && a.attributes && "value" in a.attributes) {
            a.attributes.value = "*";
            this.scrubbed++;
          }
        });
        (d.texts ?? []).forEach((t: any) => {
          if (this.ids.has(t?.id)) t.value = "*";
        });
      } else if (d.source === 5 && this.ids.has(d.id)) {
        d.text = "*";
        this.scrubbed++;
      }
    }
    return e;
  }
}
