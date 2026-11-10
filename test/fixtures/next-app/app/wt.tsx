"use client";
import { useEffect } from "react";
import { init } from "@watchtowerobservability/browser";

export function Wt() {
  useEffect(() => {
    init({ publishableKey: "wtp_fixture", endpoint: "http://127.0.0.1:1", service: "fixture", replay: { enabled: true } });
  }, []);
  return null;
}
