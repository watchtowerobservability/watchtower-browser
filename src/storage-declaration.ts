import decl from "./storage-declaration.json" with { type: "json" };

export interface StorageItem {
  type: "sessionStorage" | "localStorage" | "indexedDB" | "cookie";
  name: string;
  purpose: string;
  lifetime: string;
  /** `always`, `consent` (only after consent when `consent: "pending"`), or `option:<name>` */
  writtenWhen: string;
}
export interface StorageDeclaration {
  package: string;
  cookies: false;
  items: StorageItem[];
}

/** Every client-side storage item the SDK writes; also shipped as `dist/storage.json`. */
export const storageDeclaration = decl as StorageDeclaration;
