import { config } from "../../../package.json";

const WRITES_KEY = `${config.prefsPrefix}.externalMcpWritesEnabled`;
const FILES_KEY = `${config.prefsPrefix}.externalMcpFilesEnabled`;
const COMMANDS_KEY = `${config.prefsPrefix}.externalMcpCommandsEnabled`;
const READ_DIRECTORIES_KEY = `${config.prefsPrefix}.externalMcpReadDirectories`;
const WRITE_DIRECTORIES_KEY = `${config.prefsPrefix}.externalMcpWriteDirectories`;

export function areExternalMcpWritesEnabled(): boolean {
  return Zotero.Prefs.get(WRITES_KEY, true) === true;
}

export function setExternalMcpWritesEnabled(enabled: boolean): void {
  Zotero.Prefs.set(WRITES_KEY, enabled, true);
}

export function areExternalMcpFilesEnabled(): boolean {
  return Zotero.Prefs.get(FILES_KEY, true) === true;
}

export function setExternalMcpFilesEnabled(enabled: boolean): void {
  Zotero.Prefs.set(FILES_KEY, enabled, true);
}

export function areExternalMcpCommandsEnabled(): boolean {
  return Zotero.Prefs.get(COMMANDS_KEY, true) === true;
}

export function setExternalMcpCommandsEnabled(enabled: boolean): void {
  Zotero.Prefs.set(COMMANDS_KEY, enabled, true);
}

function normalizeDirectories(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readDirectories(key: string): string[] {
  const raw = Zotero.Prefs.get(key, true);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? normalizeDirectories(
          parsed.filter((value): value is string => typeof value === "string"),
        )
      : [];
  } catch {
    return [];
  }
}

function writeDirectories(key: string, values: readonly string[]): void {
  Zotero.Prefs.set(key, JSON.stringify(normalizeDirectories(values)), true);
}

export function getExternalMcpReadDirectories(): string[] {
  return readDirectories(READ_DIRECTORIES_KEY);
}

export function setExternalMcpReadDirectories(values: readonly string[]): void {
  writeDirectories(READ_DIRECTORIES_KEY, values);
}

export function getExternalMcpWriteDirectories(): string[] {
  return readDirectories(WRITE_DIRECTORIES_KEY);
}

export function setExternalMcpWriteDirectories(
  values: readonly string[],
): void {
  writeDirectories(WRITE_DIRECTORIES_KEY, values);
}
