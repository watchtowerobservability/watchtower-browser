import { init } from "@watchtowerobservability/browser";

init({ publishableKey: "wtp_fixture", endpoint: "http://127.0.0.1:1", service: "fixture", replay: { enabled: true } });
