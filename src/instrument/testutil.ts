import type { RumEventV1, WatchtowerConfig } from "../config";
import { normalizeRoute, type Ctx, type NavInfo } from "./ctx";

export const baseCfg: WatchtowerConfig = {
  publishableKey: "wtp_abcd1234_x",
  endpoint: "https://edge.test",
  otlpEndpoint: "https://otlp.test",
  service: "web",
  release: "r1",
};

export function mkCtx(cfg: Partial<WatchtowerConfig> = {}) {
  const events: RumEventV1[] = [];
  const navs: Array<(n: NavInfo) => void> = [];
  const c: Ctx = {
    cfg: { ...baseCfg, ...cfg },
    emit: (type, name, extra = {}) => void events.push({ id: "i", ts_ns: 1, type, name, attrs: {}, ...extra }),
    sessionId: () => "sess",
    route: () => normalizeRoute(location.pathname),
    isOwn: (u) => u.startsWith("https://edge.test") || u.startsWith("https://otlp.test"),
    onNav: (cb) => void navs.push(cb),
    net: new Map(),
  };
  return { c, events, nav: (n: NavInfo) => navs.forEach((f) => f(n)) };
}
