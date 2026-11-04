import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type StrategyOption = { value: string; label: string };

export type ProfileMeta = {
  id: number;
  name: string;
  keystorePath: string;
  alias: string;
  strategy: string;
  createdAt: string;
};

export type SignRequest = {
  taskId: string;
  apkPath: string;
  outDir?: string | null;
  strategy: string;
  v4: boolean;
  zipalignEnabled: boolean;
  keystorePath?: string | null;
  alias?: string | null;
  storePass?: string | null;
  keyPass?: string | null;
  profileId?: number | null;
  saveProfileName?: string | null;
};

export type SignResult = {
  ok: boolean;
  outputApk: string | null;
  error: string | null;
  durationMs: number;
  strategy: string;
  cert: string | null;
};

export type ApkInfo = {
  path: string;
  fileName: string;
  sizeBytes: number;
  package: string | null;
  versionCode: string | null;
  versionName: string | null;
  minSdk: string | null;
  targetSdk: string | null;
  maxSdk: string | null;
  verified: boolean;
  schemes: string[];
  certDn: string | null;
  certSha256: string | null;
  signerCount: string | null;
  verifyOutput: string[];
  error: string | null;
};

export type HistoryRecord = {
  id: number;
  createdAt: string;
  apk: string;
  output: string;
  strategy: string;
  ok: boolean;
  error: string | null;
  durationMs: number;
  cert: string | null;
};

export type ToolStatus = {
  java: boolean;
  keytool: boolean;
  apksigner: boolean;
  zipalign: boolean;
  javaPath: string | null;
};

export type GenerateKeystoreReq = {
  taskId: string;
  keystorePath: string;
  alias: string;
  storePass: string;
  keyPass?: string | null;
  validityDays?: number | null;
  keySize?: number | null;
  commonName: string;
  orgUnit?: string;
  org?: string;
  city?: string;
  state?: string;
  country: string;
  saveProfileName?: string | null;
  strategy?: string | null;
};

export type GenerateResult = {
  ok: boolean;
  keystorePath: string | null;
  error: string | null;
  profileSaved: boolean;
};

export type DataPaths = {
  dataDir: string;
  profiles: string;
  history: string;
};

export type LogEvent = { taskId: string; line: string };

export const api = {
  listStrategies: () => invoke<StrategyOption[]>("list_strategies"),
  checkTools: () => invoke<ToolStatus>("check_tools"),

  signApk: (req: SignRequest) => invoke<SignResult>("sign_apk", { req }),

  listProfiles: () => invoke<ProfileMeta[]>("list_profiles"),
  saveProfile: (req: {
    name: string;
    keystorePath: string;
    alias: string;
    storePass: string;
    keyPass?: string | null;
    strategy: string;
  }) => invoke<ProfileMeta>("save_profile", { req }),
  deleteProfile: (id: number) => invoke<void>("delete_profile", { id }),
  probeKeystore: (keystorePath: string, storePass: string) =>
    invoke<{ aliases: string[] }>("probe_keystore", { keystorePath, storePass }),

  generateKeystore: (req: GenerateKeystoreReq) =>
    invoke<GenerateResult>("generate_keystore", { req }),
  keystoreExists: (path: string) => invoke<boolean>("keystore_exists", { path }),

  apkInfo: (apkPath: string) => invoke<ApkInfo>("apk_info", { apkPath }),

  historyList: (limit = 500) => invoke<HistoryRecord[]>("history_list", { limit }),
  historyClear: () => invoke<void>("history_clear"),
  historyExport: (path: string) => invoke<number>("history_export", { path }),
  dataPaths: () => invoke<DataPaths>("data_paths"),
  openInExplorer: (path: string) => invoke<void>("open_in_explorer", { path }),
  testProxy: (url: string) => invoke<string>("test_proxy", { url }),

  onSignLog: (cb: (e: LogEvent) => void): Promise<UnlistenFn> =>
    listen<LogEvent>("sign-log", (ev) => cb(ev.payload)),
};

export const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export const dirName = (p: string) => {
  const i = p.lastIndexOf("\\") >= 0 ? p.lastIndexOf("\\") : p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
};
