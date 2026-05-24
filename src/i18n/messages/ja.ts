/**
 * Japanese message catalog (ADR-0021, epic #307 P2).
 *
 * The `Messages` annotation pins this object to the exact key set and value
 * shapes defined by the English source of truth ({@link
 * import("./en.js").en}). Dropping a key, adding a stray key, or changing a
 * value's param shape is a compile error — this is how en/ja key-set parity is
 * guaranteed without a runtime check. (A belt-and-suspenders runtime parity
 * test also exists, see tests/i18n/messages.test.ts.)
 */

import type { Messages } from "./en.js";

export const ja: Messages = {
  // --- global help (radar --help / radar / radar help) ----------------------
  "cli.help.tagline": "FeedRadar — ブログ/リリースフィード調査のためのマルチエージェント CLI",
  "cli.help.usage": "使い方: radar <コマンド> [オプション]",
  "cli.help.commandsHeading": "コマンド:",
  "cli.help.optionsHeading": "オプション:",
  "cli.help.optionHelp": "このヘルプを表示する",
  "cli.help.optionVersion": "バージョンを表示する",
  "cli.help.optionLang": "UI 言語 (RADAR_LANG / config より優先)",

  // --- unknown command error ------------------------------------------------
  "cli.error.unknownCommand": ({ command }: { command: string }): string =>
    `radar: 不明なコマンド '${command}' です`,
  "cli.error.unknownCommandHint": "利用可能なコマンドは 'radar --help' で確認できます。",
};
