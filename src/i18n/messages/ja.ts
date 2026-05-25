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

  // --- progress phase markers (ProgressReporter, ADR-0015, #313) ------------
  "cli.progress.loadedItem": ({ id }: { id: string }): string => `アイテムを読み込みました: ${id}`,
  "cli.progress.loadedItems": ({ count }: { count: number }): string =>
    `${count} 件のアイテムを読み込みました`,
  "cli.progress.loadedTemplate": ({ templateId }: { templateId: string }): string =>
    `テンプレートを読み込みました: ${templateId}.md`,
  "cli.progress.spawning": ({ agent }: { agent: string }): string => `${agent} を起動中`,
  "cli.progress.agentRunning": "エージェント実行中",
  "cli.progress.agentCompleted": ({ exitCode }: { exitCode: number }): string =>
    `エージェント完了 (exit ${exitCode})`,
  "cli.progress.agentFailed": "エージェント失敗",
  "cli.progress.frontmatterValidated": "フロントマター検証済み",
  "cli.progress.statusTransition": ({ from, to }: { from: string; to: string }): string =>
    `ステータス: ${from} → ${to}`,

  // --- watch-flow progress markers (#337, deferred from #313) ---------------
  "cli.progress.watchPage": ({
    sourceId,
    facet,
    page,
    pageTotal,
    items,
  }: {
    sourceId: string;
    facet: string;
    page: number;
    pageTotal: number;
    items: number;
  }): string => `[${sourceId}] ${facet}ページ ${page}/${pageTotal}: ${items} 件取得`,
  "cli.progress.watchSourceCompleted": ({
    sourceId,
    total,
    fresh,
  }: {
    sourceId: string;
    total: number;
    fresh: number;
  }): string => `[${sourceId}] 完了: 全 ${total} 件、新規 ${fresh} 件`,
  "cli.progress.stillWaiting": ({
    selector,
    elapsed,
  }: {
    selector: string;
    elapsed: string;
  }): string => `セレクタ "${selector}" を待機中… [${elapsed}]`,
  "cli.progress.watchFetching": ({ sourceId }: { sourceId: string }): string =>
    `[${sourceId}] 取得中…`,
  "cli.progress.watchKindInfo": ({ kind }: { kind: string }): string => `種別: ${kind}`,
  "cli.progress.watchFailed": ({ sourceId }: { sourceId: string }): string => `[${sourceId}] 失敗`,
  "cli.progress.htmlJsLaunching": "Chromium を起動中…",
  "cli.progress.htmlJsNavigating": ({ url }: { url: string }): string => `${url} へ移動中…`,
  "cli.progress.htmlJsWaitingSelector": ({
    selector,
    timeout,
  }: {
    selector: string;
    timeout: number;
  }): string => `セレクタ "${selector}" を待機中 (タイムアウト: ${timeout}ms)…`,
  "cli.progress.htmlJsCapturing": "ページ内容を取得中…",
  "cli.progress.htmlJsClosing": "ブラウザを終了中…",

  // --- command summaries (global help list, #311) ---------------------------
  "cli.summary.init": "ワークスペースを初期化する (sources/items/state/research/templates)",
  "cli.summary.source": "フィードソースを管理する (add | list | recipes | remove | test)",
  "cli.summary.watch": "ソースを取得しフィルタ済みアイテムを生成する (run)",
  "cli.summary.state": "ソースごとの監視 state を管理する (prune)",
  "cli.summary.research": "AI エージェントでアイテムから Markdown 調査レポートを生成する",
  "cli.summary.triage": "検出済みアイテムを LLM でトリアージする",
  "cli.summary.dismiss": "検出済みアイテムを却下する (単一 id / 複数 id / --batch)",
  "cli.summary.undismiss": "却下を取り消す (`dismissed → detected`)",
  "cli.summary.items": "ワークスペース内のアイテムを確認する (list | ...)",
  "cli.summary.review": "別の AI エージェントで既存の調査レポートをクロスレビューする",
  "cli.summary.update": "既存の調査レポートを最新アイテムに合わせて更新する",
  "cli.summary.doctor": "ワークスペース・エージェント CLI・html-js 用 Playwright を診断する",
  "cli.summary.workflow": "GitHub Actions ワークフローを生成する (generate <type>)",
  "cli.summary.routine": "Claude Code Routines を管理する (generate <type> / fire <trig_id>)",

  // --- research help (#311) -------------------------------------------------
  "cli.research.help": ({ maxItems }: { maxItems: number }): string =>
    `使い方:
  radar research <item-id> [--agent <agent-id>] [--template <template-id>]
  radar research --digest <item-id> <item-id> ... [--triage-group <group>] [--agent <agent-id>] [--template <id>]
  radar research --batch [--status <status>] [--max-items N] [--filter-tags <list>] [--agent <id>]
  radar research <item-id> --emit-payload [--digest <ids...>] [--template <id>]
  radar research --commit <path>

引数:
  <item-id>             アイテム id (items/<sourceId>/<item-id>.yaml に対応)
                        --digest と一緒に 2 件以上の id を渡すとまとめられる。
                        --batch では位置引数の id を省略する (アイテムは自動検出)。

オプション:
  --agent <agent-id>    claude-code | codex-cli | gemini-cli | copilot (既定: claude-code)
  --template <id>       templates/ 配下のテンプレート id (既定: default / digest 時: digest)
  --digest              複数アイテムを 1 つのダイジェストレポートにまとめる
  --triage-group <group> ダイジェストの slug 元: matchedKeywords の頻度ではなく
                        この triage.group をダイジェストファイル名にする。
                        単一キーワードのソースが複数グループを生成する場合に、
                        同日のグループ別ダイジェストを一意に保つため必須 (#255)。
                        省略時は matchedKeywords の slug にフォールバックする。
  --batch               --status (と --filter-tags) に一致する全アイテムを調査する。
                        --max-items の上限を尊重する。
  --status <status>     バッチモードのフィルタ: detected | triaged_research
                        (既定: detected)。\`triaged_research\` は triage アダプタが
                        昇格したアイテムを対象とし、成功時に \`researched\` へ遷移する。
  --max-items N         バッチモードで処理するアイテム数の上限 (既定: ${maxItems})。
                        超過分は破棄され warn() で通知される。暴走した検出が
                        ワークフロー内で上限を突破できないようにするため。
  --filter-tags <list>  バッチモードのカンマ区切り許可リスト。各アイテムの
                        matchedKeywords と照合する (大文字小文字を区別しない)。既定: 全件。
  --emit-payload        ホストエージェントモード: 調査ペイロードを stdout に出力し、
                        エージェントを起動しない。対話ホストセッションが SKILL 手順を
                        自ら実行し、\`radar research --commit <path>\` で確定する。
                        対話/オプトイン専用 — CI/ヘッドレスは既定の起動パスを使うこと。
  --commit <path>       ホストエージェントモード: 外部で書かれたレポート
                        (<cwd>/research/ 配下) を ResearchFrontmatterSchema で検証し、
                        detected → researched の遷移を適用する。
  --verbose             フェーズマーカーに加えエージェント CLI の stdout/stderr を流す。
  --quiet               フェーズマーカーとスピナーを抑制し、完了行のみ出力する。
                        RADAR_NO_PROGRESS=1 を設定するのと同等。

出力:
  単一アイテム: research/<YYYYMMDD>_<slug>_v1.md
  ダイジェスト: research/<YYYYMMDD>_digest_<slug>_v1.md
  バッチ:       一致アイテムごとに単一レポート 1 件 (ダイジェスト集約なし)。`,

  // --- review help (#311) ---------------------------------------------------
  "cli.review.help": ({ maxItems }: { maxItems: number }): string =>
    `使い方:
  radar review <research-id> [--agent <agent-id>] [--template <template-id>]
  radar review --batch [--status <status>] [--max-items N] [--filter-tags <list>] [--agent <id>]
  radar review <research-id> --emit-payload [--agent <id>] [--template <id>]
  radar review --commit <path>

引数:
  <research-id>         調査 id (research/<id>.md の .md を除いたベース名)
                        --batch では省略する (調査ファイルは自動検出)。

オプション:
  --agent <agent-id>    claude-code | codex-cli | gemini-cli | copilot (既定: claude-code)
  --template <id>       templates/ 配下のテンプレート id (既定: default)
  --batch               紐づくアイテムが --status (と --filter-tags) に一致する
                        未レビューの調査ファイルをすべてレビューする。
                        --max-items を尊重する (既定: ${maxItems})。
  --status <status>     バッチモードのフィルタ: researched (既定)。
                        \`researched → reviewed\` が唯一の正当な遷移で、
                        他の値は拒否される。
  --max-items N         バッチモードで処理するレポート数の上限 (既定: ${maxItems})。
  --filter-tags <list>  バッチモードのカンマ区切り許可リスト。紐づく各アイテムの
                        matchedKeywords と照合する (大文字小文字を区別しない)。
  --emit-payload        ホストエージェントモード: レビューペイロードを stdout に出力し、
                        エージェントを起動しない。対話ホストセッションがその場で
                        調査ファイルをレビューし、\`radar review --commit <path>\` で確定する。
                        対話/オプトイン専用 — CI/ヘッドレスは既定の起動パスを使うこと。
  --commit <path>       ホストエージェントモード: 外部でレビューされたレポート
                        (<cwd>/research/ 配下) を ResearchFrontmatterSchema で検証し、
                        ホストが reviewedAt / reviewedBy を刻んだことを確認し、
                        紐づくアイテムに researched → reviewed の遷移を適用する。
  --verbose             フェーズマーカーに加えエージェント CLI の stdout/stderr を流す。
  --quiet               フェーズマーカーとスピナーを抑制し、完了行のみ出力する。
                        RADAR_NO_PROGRESS=1 を設定するのと同等。

research/<research-id>.md にレビューブロックを追記し、フロントマターの
\`reviewedAt\` / \`reviewedBy\` を刻み、紐づく items/<id>.yaml の \`status\` を
\`researched\` から \`reviewed\` へ遷移させる。両更新はアトミックに行われ、
途中失敗時は調査ファイルがロールバックされる。`,

  // --- update help (#311) ---------------------------------------------------
  "cli.update.help": `使い方:
  radar update <research-id> [--agent <agent-id>] [--template <template-id>]
  radar update <research-id> --emit-payload [--template <id>]
  radar update --commit <path>

引数:
  <research-id>         調査 id (research/<id>.md の .md を除いたベース名)

オプション:
  --agent <agent-id>    claude-code | codex-cli | gemini-cli | copilot (既定: claude-code)
  --template <id>       templates/ 配下のテンプレート id (既定: default)
  --emit-payload        ホストエージェントモード: 更新ペイロードを stdout に出力し、
                        エージェントを起動しない。対話ホストセッションが SKILL 手順を
                        自ら実行し、\`radar update --commit <path>\` で確定する。
                        対話/オプトイン専用 — CI/ヘッドレスは既定の起動パスを使うこと。
  --commit <path>       ホストエージェントモード: 外部で書かれた v+1 レポート
                        (<cwd>/research/ 配下) を ResearchFrontmatterSchema で検証し、
                        \`supersedes\` 先行版に対する v+1 不変条件を確認し、
                        items.yaml には手を触れない。
  --verbose             フェーズマーカーに加えエージェント CLI の stdout/stderr を流す。
  --quiet               フェーズマーカーとスピナーを抑制し、完了行のみ出力する。
                        RADAR_NO_PROGRESS=1 を設定するのと同等。

指定した先行版 id から research/<base>_v<n+1>.md を生成し、新ファイルの
フロントマターに \`supersedes: <prev id>\` を書き込む。先行版ファイルは
決して変更されず (履歴は不変)、紐づく items/<id>.yaml の \`status\` も
そのまま残る。`,

  // --- triage help (#311) ---------------------------------------------------
  "cli.triage.runHelp": `使い方: radar triage [--dry-run | --apply | --interactive] [options]
       radar triage --emit-payload [--source <id>] [options]
       radar triage --commit <path>

ソースごとに設定された triage ポリシーで \`detected\` アイテムを分類する。

モード (排他、既定: --dry-run):
  --dry-run            提案された判定を stdout に出力する (ディスク書き込みなし)
  --apply              判定を items/<id>.yaml に書き込みステータスを遷移させる
  --interactive        --dry-run 出力 → $EDITOR → 確認 → 適用

オプション:
  --source <id>            triage を単一ソースに限定する
  --filter-tags <a,b>      matchedKeywords の許可リスト (カンマ区切り)
  --triage-agent <id>      この実行のみ policy.agent を上書きする
  --policy <path>          ソースごとのポリシーを YAML ファイルで上書きする
  --max-items N            この実行で triage するアイテム数の上限
  --audit-log <path>       全 triage 呼び出しの JSONL 監査レコードを追記する
  --emit-payload           ホストエージェントモード: triage ペイロードを stdout に出力し、
                           エージェントを起動しない。対話ホストセッションが自ら
                           アイテムを分類し決定 JSON を書き、
                           \`radar triage --commit <path>\` で確定する。
                           単一ソースグループが必要: detected アイテムを持つソースが
                           1 つだけでない限り --source を渡すこと。対話/オプトイン専用 —
                           CI/ヘッドレスは既定の起動パスを使うこと。
  --commit <path>          ホストエージェントモード: ホストが書いた決定 JSON
                           (<cwd>/triage/ 配下) をソースのポリシー + detected アイテムに対して
                           検証し、ステータス遷移を適用する。
  -v, --verbose            詳細な進捗を出力する
  -q, --quiet              進捗出力を完全に抑制する

\`triagePolicy:\` ブロックを持たないソースは警告付きでスキップされる。`,
  "cli.triage.feedbackHelp": `使い方: radar triage feedback <item-id> --correct | --wrong [--reason <text>]

過去の triage 判定に対する人手のフィードバックを記録する。
フィードバックは items/<id>.yaml > triage.feedback に追記され、
ポリシー調整のため \`radar triage stats\` (#242) で利用される。

オプション:
  --correct            過去の triage 判定を正しいとマークする
  --wrong              過去の triage 判定を誤りとマークする
  --reason <text>      自由記述の理由 (--wrong には推奨)`,
  "cli.triage.statsHelp": `使い方: radar triage stats [--since <duration>] [--source <id>] [--json]

triage 判定と人手フィードバックを集計する。
数週間 \`radar triage --apply\` を実行した後に使うと、精度/再現率の
ドリフトを浮かび上がらせ、\`triagePolicy.rules:\` の調整を提案する。
推奨される月次ループは docs/user-guide.md の \`policy tuning workflow\` を参照。

オプション:
  --since <duration>   この期間内に triage されたアイテムのみ集計する (例: 30d, 24h)
  --source <id>        統計を単一ソースに限定する (既定: 全ソース)
  --json               テキストレポートの代わりに機械可読な JSON を出力する`,
  "cli.triage.help": `使い方: radar triage <subcommand|--apply|--dry-run|--interactive> [...]

サブコマンド:
  feedback <item-id> --correct | --wrong [--reason <text>]
  stats [--since <duration>] [--source <id>] [--json]

実行モード (サブコマンド未指定時):
  --dry-run            提案された判定を出力する
  --apply              判定を items/<id>.yaml に書き込む
  --interactive        適用前に $EDITOR で判定を編集する

完全なオプション一覧は \`radar triage --help\` を参照。`,

  // --- dismiss / undismiss help (#311) --------------------------------------
  "cli.dismiss.help": ({ maxItems }: { maxItems: number }): string =>
    `使い方:
  radar dismiss <item-id> [<item-id> ...]
  radar dismiss --batch [--status <status>] [--max-items N] [--filter-tags <list>]

引数:
  <item-id>             アイテム id (items/<sourceId>/<item-id>.yaml に対応)
                        1 回の呼び出しで却下するには 2 件以上の id を渡す。
                        --batch では位置引数の id を省略する (アイテムは自動検出)。

オプション:
  --batch               --status (と --filter-tags) に一致する全アイテムを却下する。
                        --max-items の上限を尊重する (既定: ${maxItems})。
  --status <status>     バッチモードのフィルタ: detected | triaged_unsure (既定: detected)。
                        状態機械上 \`dismissed\` へ遷移できるのはこの 2 つの状態のみで、
                        他の値は拒否される。
  --max-items N         バッチモードで処理するアイテム数の上限 (既定: ${maxItems})。
                        超過分は破棄され warn() で通知される。暴走した --backfill が
                        ワークフロー内で上限を突破できないようにするため。
  --filter-tags <list>  バッチモードのカンマ区切り許可リスト。各アイテムの
                        matchedKeywords と照合する (大文字小文字を区別しない)。既定: 全件。

アイテムのステータスを \`dismissed\` へ遷移させる。\`detected\` または
\`triaged_unsure\` からのみ有効で、\`researched\` / \`reviewed\` / \`dismissed\` /
\`triaged_research\` / \`triaged_digest\` のアイテムは却下できない。

逆操作: \`radar undismiss <item-id> [--force]\`。`,
  "cli.undismiss.help": `使い方: radar undismiss <item-id> [--force]

引数:
  <item-id>             アイテム id (items/<sourceId>/<item-id>.yaml に対応)

オプション:
  --force, -f           人手由来の却下を取り消すときに必須

\`dismissed → detected\` を取り消す。
triage 由来の却下は静かに戻り、人手由来の却下は --force が必要。

\`radar dismiss\` の逆操作。`,

  // --- items help (#311) ----------------------------------------------------
  "cli.items.listHelp": `使い方: radar items list [filters] [output options]

フィルタ:
  --status <status>        detected | triaged_research | triaged_digest |
                           triaged_unsure | researched | reviewed | dismissed
  --source <id>            単一ソースに限定する
  --triage-group <name>    triage.group == <name> のアイテム
                           (ダイジェストワークフローで使用)
  --since <duration>       期限より古いアイテムを除外する (例: 7d, 24h)
  --limit N                結果件数の上限

出力オプション:
  --json                   JSON 配列を出力する (アイテムごとに 1 オブジェクト)
  --field <expr>           アイテムのフィールドを 1 行ずつ出力する (例: id, sourceId,
                           triage.decision)。ネストしたドットパスに対応。`,
  "cli.items.help": `使い方: radar items <list> [...]

サブコマンド:
  list [filters]           指定したフィルタに一致するアイテムを一覧表示する`,

  // --- watch help (#311) ----------------------------------------------------
  "cli.watch.help": `使い方: radar watch <run> [options]

サブコマンド:
  run [--source <id>] [--bootstrap | --backfill [--max-pages N]]
                  ソースを取得しアイテムを生成する

run のオプション:
  --source <id>     実行を単一ソース id に限定する
  --bootstrap       アイテムを出さずに lastSeenIds を初期化する (初回ノイズを抑制)
  --backfill        利用可能な全履歴ページを取得し、各ページのアイテムを出す。
                    完全対応 kind: json-api / github-releases / npm-registry。
                    他の kind (rss / html / html-js) は現在のページのみ返す。
  --max-pages N     pagination.maxPages の上限を上書きする (--backfill が必要)。
                    内側のページネーションのみに適用 — facet sweep は
                    このフラグに関わらず常に全 facet 値を走査する。
  -v, --verbose     progress-reporter の raw() パススルーを有効化する (アダプタの stdout)。
  -q, --quiet       ソースごとの進捗レポーターを抑制する (旧来の 1 行ログは残る)。
                    RADAR_NO_PROGRESS=1 も同じ効果。`,

  // --- doctor help (#311) ---------------------------------------------------
  "cli.doctor.help": `使い方: radar doctor [--no-proxy-check]

ワークスペースを診断し、依存関係/設定の健全性を報告する。

実施するチェック:
  - ワークスペースのディレクトリ (sources/, items/, state/, research/, templates/)
  - radar.config.yaml のスキーマ妥当性
  - エージェント CLI の利用可否 (claude / codex / gemini / copilot)
  - Playwright + Chromium のインストール (html-js ソース設定時のみ)
  - プロキシ環境変数 (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY) を資格情報マスク付きで確認
  - NODE_USE_ENV_PROXY の状態 (proxy のため radar が自己 respawn した際に有効)
  - NODE_EXTRA_CA_CERTS の状態 (TLS 傍受プロキシで必要)
  - ライブプロキシのヘルスチェック (api.github.com への HTTPS リクエスト)

オプション:
  --no-proxy-check  ライブプロキシのヘルスチェックをスキップする (オフライン向け)

終了コード:
  0  すべて ok (警告は出るがエラーはなし)
  1  1 つ以上の error レベルのチェックが失敗した`,

  // --- source help (#311) ---------------------------------------------------
  "cli.source.addHelp": `使い方: radar source add <id> --kind <kind> --url <url> [options]
       radar source add <id> --recipe <name> [overrides]

オプション:
  --kind <kind>            rss | html | html-js | github-releases | npm-registry | json-feed | json-api
  --url <url>              取得対象 URL
  --recipe <name>          バンドル済みレシピを適用する (\`radar source recipes\` 参照)。
                           --kind / --url / --selector-* / --pagination-* とは排他。
                           --name / --tags / --keywords / --exclude-keywords は
                           レシピの既定値を上書きできる。
  --name <name>            表示名 (既定は <id>)
  --tags <a,b>             カンマ区切りのタグ
  --keywords <a,b>         カンマ区切りの含めるキーワード
                           (有用な出力には必須 — 空 = 何にも一致しない)
  --exclude-keywords <a,b> カンマ区切りの除外キーワード
  --selector-<field> <css> kind=html / html-js 用の CSS セレクタ (必須: item, title, link)
                           任意: summary, publishedAt, body, tags
                           kind=html-js ではセレクタは JS 実行後の DOM に対して評価される。
                           \`js:\` ブロック (waitFor / timeout / userAgent) はフラグでは
                           設定できない。add 後に sources/<id>.yaml を編集すること。

  kind=json-api の場合:
    --pagination-strategy <s>  page | offset | cursor | link-header | token | none (既定: page)
    --pagination-param <name>  page/offset/cursor 値のクエリパラメータ名
    --pagination-start N       page/offset の初期値 (既定: 0)
    --page-size N              1 ページあたりのアイテム数
    --page-size-param <name>   page-size 値のクエリパラメータ名
    --max-pages N              走査するページ数の上限 (既定: 20)
    --next-cursor-path <jp>    next-cursor 値への JSONPath-lite (cursor/token 戦略)
    --total-path <jp>          total-count 値への JSONPath-lite (backfill の早期停止ヒント)

  kind=json-api の Selector フィールド (\`jsonSelectors.*\`) はフラグでは設定できない。
  スキーマに既定のフォールバック連鎖 (items / title / link / publishedAt / summary) があるため、
  単純な API はセレクタなしで動く。明示的なセレクタが必要な場合 (ネストフィールド、
  非標準エンベロープ) は sources/<id>.yaml を直接編集すること。

  Facet sweep (例: 年単位の sweep) はフラグでは設定できない。
  year sweep は \`--recipe aws-whats-new\` でまとめて適用する。レシピ専用の構造フィールド。`,
  "cli.source.listHelp": `使い方: radar source list [--enabled-only] [-v|--verbose]

sources/*.yaml を表形式で一覧表示する: id / kind / url / tags。

オプション:
  --enabled-only   前方互換のため予約 (現状は no-op)。
  -v, --verbose    ソースごとに keywords・trustLevel・lastFetchedAt
                   (state/<id>.yaml 由来) を含む詳細ブロックを出力する。`,
  "cli.source.removeHelp": `使い方: radar source remove <id>

sources/<id>.yaml を削除する。state/<id>.yaml と items/ は保持される。`,
  "cli.source.testHelp": `使い方: radar source test <id> [--limit N] [--show-content]

単一ソースをドライランする: 取得・フィルタし、一致アイテムを出力する。
state/ と items/ には触れない (永続化なし)。新しいソース追加時の
キーワード調整に便利。

kind=json-api では \`source test\` はページ 0 のみ取得する。
レシピが複数ページを宣言していてもページネーションは走査されない —
\`--limit N\` は出力する一致アイテム数を制限するだけで、ページ予算は変えない。
全履歴の取り込みには \`radar watch run --backfill\` を使うこと。
ページ 0 の \`Link\` ヘッダ / \`nextCursor\` 抽出は、状態を変えずに
ページネーション調整できるよう \`--show-content\` で表示される。

facet-sweep レシピでは \`source test\` は単一の facet 値のみ試す:
range facet は上限 (最新年)、enum facet は最初の値を使う。
どの値を試したかは警告で示され、キーワード調整が 1 スライスに
暗黙的に限定されないようにする。全 facet 値を sweep するには
\`radar watch run --backfill\` を実行すること。

オプション:
  --limit N        出力する一致アイテムの最大数 (既定 10)
  --show-content   各アイテム本文の先頭 200 文字、加えて
                   (kind=json-api) セレクタ採用テーブルとページネーション
                   プレビュー (次 URL / Link ヘッダ / nextCursor) も出力する。
  -v, --verbose    progress-reporter の raw() パススルーを有効化する (アダプタの stdout)。
                   kind=html-js (Playwright フェーズマーカー) で最も有用。
  -q, --quiet      進捗レポーターを完全に抑制する。RADAR_NO_PROGRESS=1 も
                   同じ効果。`,
  "cli.source.recipesHelp": `使い方: radar source recipes

バンドル済みレシピ (radar パッケージ内の recipes/*.yaml) を一覧表示する。
各レシピは次のように適用できる:
  radar source add <id> --recipe <name> [--keywords <kw>] [--tags <t>] [--name <display>]

バンドル済みレシピは radar npm パッケージに同梱される。ユーザー定義レシピは
まだ未対応。新しいバンドルレシピを追加するには、radar リポジトリの recipes/
ディレクトリに YAML を寄稿すること。`,
  "cli.source.help": `使い方: radar source <add|list|recipes|remove|test> [...]

サブコマンド:
  add <id> --kind <kind> --url <url> [...]
  add <id> --recipe <name> [--keywords <kw>] [--tags <t>] [--name <display>]
  list [--enabled-only]
  recipes
  remove <id>
  test <id> [--limit N] [--show-content]`,

  // --- workflow help (#311) -------------------------------------------------
  "cli.workflow.help": `使い方: radar workflow <subcommand> [...]

サブコマンド:
  generate <type>  GitHub Actions ワークフロー YAML を生成する
                   Types: watch | combined | combined-with-triage

type 別のオプションは \`radar workflow generate <type> --help\` を参照。`,
  "cli.workflow.generateHelp": `使い方: radar workflow generate <type> [options]

Types:
  watch                  定期的な \`radar watch run\` (cron + rebase リトライ付き state コミット)
  combined               定期的な \`radar watch run\` -> ハードキャップ付き auto research --batch
  combined-with-triage   \`watch run\` -> \`triage --apply\` -> \`research --batch\` -> グループ別 \`research --digest\` -> \`review --batch\` を 1 ジョブで

type 別のオプションは \`radar workflow generate <type> --help\` を参照。`,

  // --- per-type workflow generate help (#337, deferred from #311) -----------
  "cli.workflow.generateWatchHelp": `使い方: radar workflow generate watch [options]

cron スケジュールで \`radar watch run\` を実行する GitHub Actions ワークフローを生成する。
生成されるワークフローには、他の同時実行ワークフローとの push 競合を緩和するための
git pull --rebase リトライ処理が含まれる。

オプション:
  --cron <expression>   5 フィールドの cron 式 (デフォルト: "0 0 * * *")
  --output <path>       .github/workflows/ 配下の出力ファイル
                        (デフォルト: .github/workflows/feedradar-watch.yaml)
  --agent <name>        claude-code | codex-cli | gemini-cli | copilot (デフォルト: claude-code)
                        ワークフローが参照するシークレット名を決定する。
  --force, -f           既存の出力ファイルを上書きする
  --lang <en|ja>        生成される YAML のコメント / ステップ名の言語
                        (デフォルト: en; RADAR_LANG と config.locale も参照)

必要なシークレット (Settings → Secrets and variables → Actions):
  ANTHROPIC_API_KEY    --agent claude-code のとき (デフォルト)
  OPENAI_API_KEY       --agent codex-cli のとき
  GEMINI_API_KEY       --agent gemini-cli のとき
  GITHUB_TOKEN         --agent copilot では自動付与 (設定不要)`,
  "cli.workflow.generateCombinedHelp": ({ maxItems }: { maxItems: number }): string =>
    `使い方: radar workflow generate combined [options]

\`radar watch run\` -> 新規アイテムなしガード -> \`radar research --batch\` を
連結し、コストをハードキャップで制御する GitHub Actions ワークフローを生成する。

オプション:
  --watch-cron <expression>  5 フィールドの cron 式 (デフォルト: "0 0 * * *")
  --output <path>            .github/workflows/ 配下の出力ファイル
                             (デフォルト: .github/workflows/feedradar-combined.yaml)
  --agent <name>             claude-code | codex-cli | gemini-cli | copilot (デフォルト: claude-code)
  --max-items N              1 回あたりの auto-research のハードキャップ (デフォルト: ${maxItems})
  --filter-tags <list>       matchedKeywords のカンマ区切り許可リスト
                             (デフォルト: 未指定。検出された全アイテムにマッチ)
  --force, -f                既存の出力ファイルを上書きする
  --lang <en|ja>             生成される YAML のコメント / ステップ名の言語
                             (デフォルト: en; RADAR_LANG と config.locale も参照)

必要なシークレット (Settings → Secrets and variables → Actions):
  ANTHROPIC_API_KEY    --agent claude-code のとき (デフォルト)
  OPENAI_API_KEY       --agent codex-cli のとき
  GEMINI_API_KEY       --agent gemini-cli のとき
  GITHUB_TOKEN         --agent copilot では自動付与 (設定不要)`,
  "cli.workflow.generateCombinedWithTriageHelp": ({
    watchCron,
    output,
    maxItems,
  }: {
    watchCron: string;
    output: string;
    maxItems: number;
  }): string =>
    `使い方: radar workflow generate combined-with-triage [options]

\`radar watch run\` -> \`radar triage --apply\` -> \`radar research --batch --status triaged_research\` ->
グループ別 \`radar research --digest\` -> \`radar review --batch\` を 1 ジョブで連結する
GitHub Actions ワークフローを生成する。

オプション:
  --watch-cron <expression>  5 フィールドの cron 式 (デフォルト: "${watchCron}")
  --output <path>            .github/workflows/ 配下の出力ファイル
                             (デフォルト: ${output})
  --triage-agent <name>      claude-code | codex-cli | gemini-cli | copilot (デフォルト: gemini-cli)
  --research-agent <name>    claude-code | codex-cli | gemini-cli | copilot (デフォルト: claude-code)
  --review-agent <name>      claude-code | codex-cli | gemini-cli | copilot (デフォルト: codex-cli)
  --max-items N              1 回あたりの research --batch のハードキャップ (デフォルト: ${maxItems})
  --slack-webhook <ref>      triaged_unsure キュー通知用のシークレット参照
                             (例: secrets.SLACK_WEBHOOK) (任意)
  --output-mode <mode>       pr | direct-commit (デフォルト: pr)。'pr' はレビュー用
                             PR を開く。'direct-commit' はデフォルトブランチへ直接
                             コミット & push する (pull-requests: write を外す)
  --force, -f                既存の出力ファイルを上書きする
  --lang <en|ja>             生成される YAML のコメント / ステップ名の言語
                             (デフォルト: en; RADAR_LANG と config.locale も参照)

必要なシークレット (Settings → Secrets and variables → Actions):
  ANTHROPIC_API_KEY  いずれかのロールが --agent claude-code を使うとき
  OPENAI_API_KEY     いずれかのロールが --agent codex-cli を使うとき
  GEMINI_API_KEY     いずれかのロールが --agent gemini-cli を使うとき (triage のデフォルト)
  GITHUB_TOKEN       自動付与 (設定不要)`,

  // --- routine help (#311) --------------------------------------------------
  "cli.routine.help": `使い方: radar routine <subcommand> [...]

サブコマンド:
  generate <type>  Claude Code Routine YAML を生成する (.claude/routines/)
                   Types: watch | pipeline
  fire <trig_id>   登録済みルーティンを外部から起動する (/fire API)

サブコマンド別のオプションは \`radar routine <subcommand> --help\` を参照。`,
  "cli.routine.generateHelp": `使い方: radar routine generate <type> [options]

Types:
  watch     定期的な \`radar watch run\` 自セッションルーティン。items/state を claude/* ブランチにコミットする
  pipeline  watch -> triage -> research -> review の全工程を 1 アイテムずつ行う自セッションルーティン

type 別のオプションは \`radar routine generate <type> --help\` を参照。`,

  // --- per-type routine generate / fire help (#337, deferred from #311) -----
  "cli.routine.generateWatchHelp": ({ models }: { models: string }): string =>
    `使い方: radar routine generate watch [options]

スケジュールで \`radar watch run\` を実行し、検出した items/state を claude/* ブランチへ
コミットする Claude Code Routine YAML を生成する。
このルーティンは 1 つの Claude セッションで完結し、他のエージェントを起動しない。

オプション:
  --name <name>         ルーティン名 (デフォルト: "feedradar-watch")
                        デフォルトの出力ファイル名も兼ねる。
  --repo <owner/repo>   対象リポジトリ (デフォルト: <owner>/<repo>)
  --cron <expression>   5 フィールドの cron、最小間隔は 1 時間 (デフォルト: "0 * * * *")
                        1 時間未満 (例: "*/5 * * * *") は拒否される。
  --timezone <tz>       スケジュールのタイムゾーン (デフォルト: "UTC")
  --model <name>        ${models}
                        (デフォルト: claude-sonnet-4-6)
  --prompt-mode <mode>  inline | bootstrap (デフォルト: inline)。'bootstrap' は完了時に
                        Web UI へ貼る短いプロンプトを出力する (ルーティンは実行時に
                        コミット済み YAML から instructions を読むため、編集ごとの
                        再貼り付けが不要)。どちらのモードでも生成 YAML の
                        instructions ブロックは変わらない。
  --emit-bootstrap-prompt
                        bootstrap プロンプト本文のみを stdout に出力して終了する
                        (read-only: YAML を書かず、貼り付け案内も出さない)。
                        bootstrap prompt-mode が貼り付ける文面と同一で、
                        /routine-setup skill が登録ボディの作成に使う。
  --output <path>       .claude/routines/ 配下の出力ファイル
                        (デフォルト: .claude/routines/<name>.yaml)
  --force, -f           既存の出力ファイルを上書きする
  --lang <en|ja>        生成される YAML のメモ / 手順 / コメントの言語
                        (デフォルト: en; RADAR_LANG と config.locale も参照)`,
  "cli.routine.generatePipelineHelp": ({
    models,
    maxItems,
  }: {
    models: string;
    maxItems: number;
  }): string =>
    `使い方: radar routine generate pipeline [options]

1 つのセッションで全工程 — \`radar watch run\` -> triage -> research -> review — を
順番に実行し、アイテムを 1 件ずつ処理する Claude Code Routine YAML を生成する。
他のエージェントを起動しないため、GHA combined-with-triage ワークフローのような
エージェント間レビューは含まれない。1 回あたりの処理件数は CLI フラグで制限される。

オプション:
  --name <name>         ルーティン名 (デフォルト: "feedradar-pipeline")
                        デフォルトの出力ファイル名も兼ねる。
  --repo <owner/repo>   対象リポジトリ (デフォルト: <owner>/<repo>)
  --cron <expression>   5 フィールドの cron、最小間隔は 1 時間 (デフォルト: "0 * * * *")
                        1 時間未満 (例: "*/5 * * * *") は拒否される。
  --timezone <tz>       スケジュールのタイムゾーン (デフォルト: "UTC")
  --model <name>        ${models}
                        (デフォルト: claude-sonnet-4-6)
  --max-items N         1 回あたりに triage/research/review するアイテム数のハードキャップ
                        (デフォルト: ${maxItems})。triage --max-items と items --limit を駆動する。
  --output-mode <mode>  pr | auto-merge (デフォルト: pr)。'auto-merge' はルーティン自身の
                        PR を main へ squash マージする (Web UI の 'Allow unrestricted
                        branch pushes' トグルが必要)。
  --prompt-mode <mode>  inline | bootstrap (デフォルト: inline)。'bootstrap' は完了時に
                        Web UI へ貼る短いプロンプトを出力する (ルーティンは実行時に
                        コミット済み YAML から instructions を読むため、編集ごとの
                        再貼り付けが不要)。どちらのモードでも生成 YAML の
                        instructions ブロックは変わらない。
  --emit-bootstrap-prompt
                        bootstrap プロンプト本文のみを stdout に出力して終了する
                        (read-only: YAML を書かず、貼り付け案内も出さない)。
                        bootstrap prompt-mode が貼り付ける文面と同一で、
                        /routine-setup skill が登録ボディの作成に使う。
  --output <path>       .claude/routines/ 配下の出力ファイル
                        (デフォルト: .claude/routines/<name>.yaml)
  --force, -f           既存の出力ファイルを上書きする
  --lang <en|ja>        生成される YAML のメモ / 手順 / コメントの言語
                        (デフォルト: en; RADAR_LANG と config.locale も参照)`,
  "cli.routine.fireHelp": ({ tokenEnv }: { tokenEnv: string }): string =>
    `使い方: radar routine fire <trig_id> [options]

登録済みの Claude Code Routine を /fire API 経由で外部から起動する。
この呼び出しはルーティンセッションが作成された時点で返り、
セッションの完了は待たない。

引数:
  <trig_id>             Web UI で発行されるルーティン id ('trig_' で始まる)

オプション:
  --text <msg>          自由形式の起動コンテキスト (リクエストボディの \`text\`)。
                        API は解析せず、そのまま渡される。
  --token-env <NAME>    ルーティンごとの bearer トークンを保持する環境変数名
                        (デフォルト: ${tokenEnv})。
  --lang <en|ja>        このコマンドのメッセージ / ヘルプの表示言語
                        (既定: en; RADAR_LANG と config.locale も尊重)

ルーティンごとのトークンは Web UI で一度だけ発行される (再生成 / 失効も Web UI で行う)。
トークンは環境変数から読み取られ、フラグとしては受け付けず、出力もされない。`,

  // --- user-facing errors & result notifications (#312) ---------------------
  // dismiss (#312)
  "cli.dismiss.batchIncompatiblePositional": ({ count }: { count: number }): string =>
    `dismiss: --batch は位置引数の <item-id> と併用できません (${count} 件指定されました)`,
  "cli.dismiss.invalidStatus": ({ status, allowed }: { status: string; allowed: string }): string =>
    `dismiss: 不正な --status '${status}' (有効値: ${allowed})`,
  "cli.dismiss.statusRequiresBatch": "dismiss: --status は --batch と併用してください",
  "cli.dismiss.maxItemsRequiresBatch": "dismiss: --max-items は --batch と併用してください",
  "cli.dismiss.filterTagsRequiresBatch": "dismiss: --filter-tags は --batch と併用してください",
  "cli.dismiss.invalidMaxItemsInteger": ({ raw }: { raw: string }): string =>
    `dismiss: 不正な --max-items '${raw}' (正の整数を指定してください)`,
  "cli.dismiss.invalidMaxItemsPositive": ({ raw }: { raw: string }): string =>
    `dismiss: 不正な --max-items '${raw}' (0 より大きい値を指定してください)`,
  "cli.dismiss.missingItemId": "dismiss: <item-id> が指定されていません",
  "cli.dismiss.itemNotFound": ({ id }: { id: string }): string =>
    `dismiss: アイテム '${id}' が items/ 配下に見つかりません`,
  "cli.dismiss.itemWrongStatus": ({
    id,
    status,
    allowed,
    nextStatuses,
  }: {
    id: string;
    status: string;
    allowed: string;
    nextStatuses: string;
  }): string =>
    `dismiss: アイテム '${id}' のステータスは '${status}' です。期待値: ${allowed} のいずれか (dismiss はこれらのステータスからのみ 'dismissed' に遷移できます)。'${status}' から遷移可能なステータス: ${nextStatuses}`,
  "cli.dismiss.failedUpdate": ({ reason }: { reason: string }): string =>
    `dismiss: アイテムのステータス更新に失敗しました: ${reason}`,
  "cli.dismiss.transitioned": ({ sourceId, id }: { sourceId: string; id: string }): string =>
    `dismiss: items/${sourceId}/${id}.yaml のステータスを dismissed に変更しました`,
  "cli.dismiss.noItemsMatched": ({ status, tags }: { status: string; tags: string }): string =>
    `dismiss: --batch のフィルタに一致するアイテムがありません (status=${status}${tags})`,
  "cli.dismiss.capReached": ({
    maxItems,
    dropped,
    matched,
  }: {
    maxItems: number;
    dropped: number;
    matched: number;
  }): string =>
    `dismiss: --max-items ${maxItems} の上限に達しました。超過した ${dropped} 件を除外します (一致 ${matched} 件)`,
  "cli.dismiss.batchWillProcess": ({
    count,
    status,
    tags,
    cap,
  }: {
    count: number;
    status: string;
    tags: string;
    cap: number;
  }): string =>
    `dismiss: --batch で ${count} 件を処理します (status=${status}${tags}, 上限=${cap})`,
  "cli.dismiss.batchCompleted": ({ count }: { count: number }): string =>
    `dismiss: --batch で ${count} 件を処理しました`,

  // undismiss (#312)
  "cli.undismiss.missingItemId": "undismiss: <item-id> が指定されていません",
  "cli.undismiss.itemsDirNotFound":
    "undismiss: items/ が見つかりません (`radar init` を実行してください)",
  "cli.undismiss.itemNotFound": ({ id }: { id: string }): string =>
    `undismiss: アイテム '${id}' が items/ 配下に見つかりません`,
  "cli.undismiss.notDismissed": ({ id, status }: { id: string; status: string }): string =>
    `undismiss: アイテム '${id}' のステータスは '${status}' です。期待値: 'dismissed' (undismiss は dismiss の取り消しのみを行い、他の遷移には使えません)`,
  "cli.undismiss.forbiddenTransition":
    "undismiss: ステートマシンが 'dismissed → detected' を許可していません (内部エラー)",
  "cli.undismiss.humanOriginRequiresForce": ({ id }: { id: string }): string =>
    `undismiss: アイテム '${id}' は人間によって dismiss されています。取り消すには --force を指定してください (意図的な安全ガードです)`,
  "cli.undismiss.failedUpdate": ({ reason }: { reason: string }): string =>
    `undismiss: アイテムの更新に失敗しました: ${reason}`,
  "cli.undismiss.revertedHumanOrigin": ({ id }: { id: string }): string =>
    `undismiss: 人間由来の dismiss を取り消しました: '${id}' (--force 使用)`,
  "cli.undismiss.transitioned": ({ sourceId, id }: { sourceId: string; id: string }): string =>
    `undismiss: items/${sourceId}/${id}.yaml のステータスを detected に変更しました`,

  // doctor diagnostics (#312)
  "cli.doctor.workspaceDirExists": ({ dir }: { dir: string }): string => `${dir}/ は存在します`,
  "cli.doctor.workspaceDirMissing": ({ dir }: { dir: string }): string =>
    `${dir}/ がありません — \`radar init\` でワークスペースを作成してください`,
  "cli.doctor.configValid": "radar.config.yaml は有効です (または存在せず、既定値が適用されます)",
  "cli.doctor.configInvalid": ({ reason }: { reason: string }): string =>
    `radar.config.yaml が不正です: ${reason}`,
  "cli.doctor.agentFound": ({
    agent,
    binary,
    path,
  }: {
    agent: string;
    binary: string;
    path: string;
  }): string => `${agent}: ${binary} が ${path} に見つかりました`,
  "cli.doctor.agentMissing": ({ agent, binary }: { agent: string; binary: string }): string =>
    `${agent}: ${binary} が PATH に見つかりません (\`radar research --agent ${agent}\` を使うにはインストールしてください)`,
  "cli.doctor.playwrightNotRequired": "playwright: 不要です (html-js ソースが設定されていません)",
  "cli.doctor.playwrightOk": ({ path }: { path: string }): string =>
    `playwright: 正常 — chromium は ${path} にあります`,
  "cli.doctor.playwrightModuleMissing": ({
    sources,
    hint,
  }: {
    sources: string;
    hint: string;
  }): string =>
    `playwright: モジュールがインストールされていません (html-js ソースに必要: ${sources})\n  ${hint}`,
  "cli.doctor.playwrightChromiumMissing": ({
    path,
    sources,
    hint,
  }: {
    path: string;
    sources: string;
    hint: string;
  }): string =>
    `playwright: chromium が '${path}' に見つかりません (html-js ソースに必要: ${sources})\n  ${hint}`,
  "cli.doctor.proxyEnvAllProxyOnly": ({
    source,
    masked,
  }: {
    source: string;
    masked: string;
  }): string =>
    `proxy: $${source}=${masked} を検出しました (Node --use-env-proxy は ALL_PROXY を無視します。HTTPS_PROXY または HTTP_PROXY を設定してください)`,
  "cli.doctor.proxyEnvDetected": ({ source, masked }: { source: string; masked: string }): string =>
    `proxy: $${source}=${masked} を検出しました`,
  "cli.doctor.proxyEnvNone":
    "proxy: プロキシ環境変数が設定されていません (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY)",
  "cli.doctor.proxyActive": "proxy: NODE_USE_ENV_PROXY が有効です (radar が自動適用)",
  "cli.doctor.proxyActiveMissing":
    "proxy: NODE_USE_ENV_PROXY が未設定です。fetch が HTTPS_PROXY を無視する場合は radar を bin 経由で再実行してください (直接 import しない)",
  "cli.doctor.proxyActiveNotRequired": "proxy: NODE_USE_ENV_PROXY は不要です (プロキシ未検出)",
  "cli.doctor.tlsCaSet": ({ path }: { path: string }): string => `tls: NODE_EXTRA_CA_CERTS=${path}`,
  "cli.doctor.tlsCaUnset":
    "tls: NODE_EXTRA_CA_CERTS が未設定です (TLS を傍受するプロキシでは失敗する可能性があります)",
  "cli.doctor.healthcheckSkippedFlag": "proxy healthcheck: スキップしました (--no-proxy-check)",
  "cli.doctor.healthcheckSkippedNoProxy": "proxy healthcheck: スキップしました (プロキシ未検出)",
  "cli.doctor.healthcheck407": ({ url }: { url: string }): string =>
    `proxy healthcheck: ${url} から 407 Proxy Authentication Required ($HTTPS_PROXY の userinfo を確認してください)`,
  "cli.doctor.healthcheckOk": ({
    status,
    statusText,
    elapsed,
  }: {
    status: number;
    statusText: string;
    elapsed: number;
  }): string =>
    `proxy healthcheck: 正常 (api.github.com から ${status} ${statusText}、${elapsed}ms)`,
  "cli.doctor.healthcheckOther": ({
    status,
    statusText,
    elapsed,
  }: {
    status: number;
    statusText: string;
    elapsed: number;
  }): string =>
    `proxy healthcheck: api.github.com から ${status} ${statusText}、${elapsed}ms`.trimEnd(),
  "cli.doctor.healthcheckTimeout": ({ elapsed }: { elapsed: number }): string =>
    `proxy healthcheck: ${elapsed}ms 後にタイムアウト (プロキシに到達できない可能性があります。$HTTPS_PROXY の host:port を確認してください)`,
  "cli.doctor.healthcheckTls": ({ code }: { code: string }): string =>
    `proxy healthcheck: TLS エラー (${code})。プロキシの傍受用 CA を信頼するには NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem を設定してください。`,
  "cli.doctor.healthcheckRefused":
    "proxy healthcheck: 接続が拒否されました。$HTTPS_PROXY の host:port に到達できるか確認してください。",
  "cli.doctor.healthcheckDns": ({ code }: { code: string }): string =>
    `proxy healthcheck: DNS の名前解決に失敗しました (${code})。$HTTPS_PROXY のプロキシホストを解決できません。`,
  "cli.doctor.healthcheckResetTimeout": ({ code }: { code: string }): string =>
    `proxy healthcheck: 接続が${code === "ETIMEDOUT" ? "タイムアウトしました" : "リセットされました"} (${code})。`,
  "cli.doctor.healthcheckFailed": ({ reason }: { reason: string }): string =>
    `proxy healthcheck: 失敗 — ${reason}`,
  "cli.doctor.summary": ({
    ok,
    warn,
    error,
  }: {
    ok: number;
    warn: number;
    error: number;
  }): string => `doctor: ${ok} ok, ${warn} warn, ${error} error`,

  // init result summary / next-steps (#312)
  "cli.init.workspaceReady": ({ cwd }: { cwd: string }): string =>
    `init: ワークスペースを ${cwd} に準備しました`,
  "cli.init.directoriesCreated": ({ dirs }: { dirs: string }): string =>
    `init: ディレクトリを作成しました: ${dirs}`,
  "cli.init.skillsCopied": ({ files }: { files: string }): string =>
    `init: スキルをコピーしました: ${files}`,
  "cli.init.filesSkipped": ({ files }: { files: string }): string =>
    `init: スキップしたファイル: ${files}`,
  "cli.init.nextSteps":
    "init: 次のステップ — 自然言語やスラッシュの使い方は FEEDRADAR.md を参照してください。",

  // items (#312)
  "cli.items.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `items: 不明なサブコマンド '${sub}' です`,
  "cli.items.invalidStatus": ({ status, allowed }: { status: string; allowed: string }): string =>
    `items list: 不正な --status '${status}' (有効値: ${allowed})`,
  "cli.items.invalidSince": ({ since }: { since: string }): string =>
    `items list: 不正な --since '${since}' (形式: Ns | Nm | Nh | Nd)`,
  "cli.items.noItemsDir":
    "items list: items/ ディレクトリがありません (まず `radar init` を実行してください)",
  "cli.items.noMatch": "items list: フィルタに一致するアイテムがありません",

  // watch (#312 / #336)
  "cli.watch.bootstrapBackfillExclusive": "--bootstrap と --backfill は併用できません",
  "cli.watch.maxPagesRequiresBackfill": "--max-pages には --backfill が必要です",
  "cli.watch.verboseQuietExclusive": "--verbose と --quiet は併用できません",
  "cli.watch.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `watch: 不明なサブコマンド '${sub}' です`,
  "cli.watch.bootstrapComplete": ({ sources }: { sources: number }): string =>
    `watch run: bootstrap 完了 (${sources} ソース)`,
  "cli.watch.backfillComplete": ({ total, sources }: { total: number; sources: number }): string =>
    `watch run: backfill 完了 — ${sources} ソースで ${total} 件のアイテムを取り込みました`,
  "cli.watch.runComplete": ({ total, sources }: { total: number; sources: number }): string =>
    `watch run: ${sources} ソースで ${total} 件の新規アイテム`,

  // zod-validation error preamble (#312)
  "cli.config.schemaViolation": ({ file, issues }: { file: string; issues: string }): string =>
    `${file} のスキーマ違反:\n${issues}`,
  "cli.config.failedRead": ({ file, reason }: { file: string; reason: string }): string =>
    `${file} の読み込みに失敗しました: ${reason}`,
  "cli.config.failedParse": ({ file, reason }: { file: string; reason: string }): string =>
    `${file} の YAML としての解析に失敗しました: ${reason}`,

  // --- remaining user-facing errors & notifications (#336) ------------------

  // shared: invalid --agent
  "cli.agent.invalid": ({ cmd, agent }: { cmd: string; agent: string }): string =>
    `${cmd}: 不正な --agent '${agent}' (有効値: claude-code | codex-cli | gemini-cli | copilot)`,

  // research (#336)
  "cli.research.batchIncompatiblePositional": ({ count }: { count: number }): string =>
    `research: --batch と位置引数の <item-id> は併用できません (${count} 件指定)`,
  "cli.research.batchIncompatibleDigest": "research: --batch と --digest は併用できません",
  "cli.research.batchIncompatibleTriageGroup":
    "research: --batch と --triage-group は併用できません",
  "cli.research.invalidStatus": ({
    status,
    allowed,
  }: {
    status: string;
    allowed: string;
  }): string => `research: 不正な --status '${status}' (有効値: ${allowed})`,
  "cli.research.invalidMaxItemsInteger": ({ raw }: { raw: string }): string =>
    `research: 不正な --max-items '${raw}' (正の整数を指定してください)`,
  "cli.research.invalidMaxItemsPositive": ({ raw }: { raw: string }): string =>
    `research: 不正な --max-items '${raw}' (0 より大きい値を指定してください)`,
  "cli.research.commitIncompatibleBatch": "research: --commit と --batch は併用できません",
  "cli.research.commitIncompatibleDigest": "research: --commit と --digest は併用できません",
  "cli.research.commitIncompatibleEmitPayload":
    "research: --commit と --emit-payload は併用できません",
  "cli.research.commitIncompatibleTriageGroup":
    "research: --commit と --triage-group は併用できません",
  "cli.research.commitTakesPath": ({ count, ids }: { count: number; ids: string }): string =>
    `research: --commit は <path> を取ります。<item-id> 引数ではありません (${count} 件: ${ids})`,
  "cli.research.emitPayloadIncompatibleBatch":
    "research: --emit-payload と --batch は併用できません",
  "cli.research.statusRequiresBatch": "research: --status には --batch が必要です",
  "cli.research.maxItemsRequiresBatch": "research: --max-items には --batch が必要です",
  "cli.research.filterTagsRequiresBatch": "research: --filter-tags には --batch が必要です",
  "cli.research.triageGroupRequiresDigest": "research: --triage-group には --digest が必要です",
  "cli.research.missingItemId": "research: <item-id> が指定されていません",
  "cli.research.multipleRequireDigest": ({ count, ids }: { count: number; ids: string }): string =>
    `research: 複数の <item-id> 引数には --digest が必要です (${count} 件: ${ids})`,
  "cli.research.digestRequiresTwo": ({ count }: { count: number }): string =>
    `research: --digest には 2 つ以上の <item-id> 引数が必要です (${count} 件指定)`,
  "cli.research.itemNotFound": ({ id }: { id: string }): string =>
    `research: アイテム '${id}' が items/ 配下に見つかりません`,
  "cli.research.digestDismissed": ({ ids }: { ids: string }): string =>
    `research: dismiss 済みのアイテムをダイジェストに含めることはできません: ${ids}`,
  "cli.research.alreadyExists": ({ path }: { path: string }): string =>
    `research: ${path} は既に存在します (再 research には \`radar update\` を使用してください)`,
  "cli.research.noItemsMatched": ({ status, tags }: { status: string; tags: string }): string =>
    `research: --batch フィルタに一致するアイテムがありません (status=${status}${tags})`,
  "cli.research.capReached": ({
    maxItems,
    dropped,
    matched,
  }: {
    maxItems: number;
    dropped: number;
    matched: number;
  }): string =>
    `research: --max-items ${maxItems} の上限に達しました。超過した ${dropped} 件を除外します (一致 ${matched} 件)`,
  "cli.research.batchWillProcess": ({
    count,
    status,
    tags,
    agent,
    cap,
  }: {
    count: number;
    status: string;
    tags: string;
    agent: string;
    cap: number;
  }): string =>
    `research: --batch で ${count} 件を処理します (status=${status}${tags}, agent=${agent}, 上限=${cap})`,
  "cli.research.batchHalted": ({ id, exitCode }: { id: string; exitCode: number }): string =>
    `research: --batch がアイテム '${id}' で停止しました (exit ${exitCode})`,
  "cli.research.batchCompleted": ({ count }: { count: number }): string =>
    `research: --batch で ${count} 件を処理しました`,
  "cli.research.wrote": ({ path }: { path: string }): string =>
    `research: ${path} を書き込みました`,
  "cli.research.transitioned": ({ sourceId, id }: { sourceId: string; id: string }): string =>
    `research: items/${sourceId}/${id}.yaml のステータスを researched に変更しました`,

  // review (#336)
  "cli.review.batchIncompatiblePositional": ({ researchId }: { researchId: string }): string =>
    `review: --batch と位置引数の <research-id> は併用できません ('${researchId}')`,
  "cli.review.invalidStatus": ({ status, allowed }: { status: string; allowed: string }): string =>
    `review: 不正な --status '${status}' (有効値: ${allowed})`,
  "cli.review.invalidMaxItemsInteger": ({ raw }: { raw: string }): string =>
    `review: 不正な --max-items '${raw}' (正の整数を指定してください)`,
  "cli.review.invalidMaxItemsPositive": ({ raw }: { raw: string }): string =>
    `review: 不正な --max-items '${raw}' (0 より大きい値を指定してください)`,
  "cli.review.commitIncompatibleBatch": "review: --commit と --batch は併用できません",
  "cli.review.commitIncompatibleEmitPayload": "review: --commit と --emit-payload は併用できません",
  "cli.review.commitTakesPath": ({ researchId }: { researchId: string }): string =>
    `review: --commit は <path> を取ります。<research-id> 引数ではありません ('${researchId}')`,
  "cli.review.emitPayloadIncompatibleBatch": "review: --emit-payload と --batch は併用できません",
  "cli.review.statusRequiresBatch": "review: --status には --batch が必要です",
  "cli.review.maxItemsRequiresBatch": "review: --max-items には --batch が必要です",
  "cli.review.filterTagsRequiresBatch": "review: --filter-tags には --batch が必要です",
  "cli.review.missingResearchId": "review: <research-id> が指定されていません",
  "cli.review.fileNotFound": ({ path }: { path: string }): string =>
    `review: research ファイルが見つかりません: ${path}`,
  "cli.review.batchFoundNone":
    "review: --batch で未レビューの research/*.md ファイルが見つかりません",
  "cli.review.batchMatchedZero": ({ status, tags }: { status: string; tags: string }): string =>
    `review: --batch に一致する research ファイルがありません (status=${status}${tags})`,
  "cli.review.capReached": ({
    maxItems,
    dropped,
    matched,
  }: {
    maxItems: number;
    dropped: number;
    matched: number;
  }): string =>
    `review: --max-items ${maxItems} の上限に達しました。超過した ${dropped} 件の research ファイルを除外します (一致 ${matched} 件)`,
  "cli.review.batchWillProcess": ({
    count,
    status,
    tags,
    agent,
    cap,
  }: {
    count: number;
    status: string;
    tags: string;
    agent: string;
    cap: number;
  }): string =>
    `review: --batch で ${count} 件の research ファイルを処理します (status=${status}${tags}, agent=${agent}, 上限=${cap})`,
  "cli.review.batchHalted": ({
    researchId,
    exitCode,
  }: {
    researchId: string;
    exitCode: number;
  }): string => `review: --batch が research '${researchId}' で停止しました (exit ${exitCode})`,
  "cli.review.batchCompleted": ({ count }: { count: number }): string =>
    `review: --batch で ${count} 件の research ファイルを処理しました`,
  "cli.review.commitNotStamped": ({
    id,
    reviewedAt,
    reviewedBy,
  }: {
    id: string;
    reviewedAt: string;
    reviewedBy: string;
  }): string =>
    `review: --commit レポート '${id}' にスタンプがありません (reviewedAt=${reviewedAt}, reviewedBy=${reviewedBy})。commit 前にホストセッションがレビューをスタンプする必要があります`,
  "cli.review.alreadyReviewed": ({
    id,
    reviewedAt,
    reviewedBy,
  }: {
    id: string;
    reviewedAt: string;
    reviewedBy: string;
  }): string =>
    `review: research '${id}' は既にレビュー済みです (reviewedAt=${reviewedAt}, reviewedBy=${reviewedBy})`,
  "cli.review.wroteCommit": ({ path }: { path: string }): string =>
    `review: ${path} を書き込みました`,
  "cli.review.stamped": ({
    path,
    reviewedAt,
    reviewedBy,
  }: {
    path: string;
    reviewedAt: string;
    reviewedBy: string;
  }): string =>
    `review: ${path} に reviewedAt=${reviewedAt} reviewedBy=${reviewedBy} をスタンプしました`,
  "cli.review.transitioned": ({ sourceId, id }: { sourceId: string; id: string }): string =>
    `review: items/${sourceId}/${id}.yaml のステータスを reviewed に変更しました`,

  // update (#336)
  "cli.update.commitIncompatibleEmitPayload": "update: --commit と --emit-payload は併用できません",
  "cli.update.commitTakesPath": ({ researchId }: { researchId: string }): string =>
    `update: --commit は <path> を取ります。<research-id> ではありません ('${researchId}')`,
  "cli.update.missingResearchId": "update: <research-id> が指定されていません",
  "cli.update.fileNotFound": ({ path }: { path: string }): string =>
    `update: research ファイルが見つかりません: ${path}`,
  "cli.update.alreadyExists": ({ path, version }: { path: string; version: number }): string =>
    `update: ${path} は既に存在します。v${version} は既に生成済みです — 別の predecessor を選ぶか、古いファイルを削除してください。`,
  "cli.update.commitSupersedesNull":
    "update: --commit レポートの `supersedes` が null です。update は v+1 を確定します (v1 には `radar research --commit` を使用してください)。",
  "cli.update.wrote": ({ path }: { path: string }): string => `update: ${path} を書き込みました`,
  "cli.update.supersedes": ({ prevId }: { prevId: string }): string =>
    `update: ${prevId} を supersede しました (items.yaml のステータスは変更なし)`,

  // source (#336)
  "cli.source.missingId": ({ sub }: { sub: string }): string =>
    `source ${sub}: <id> が指定されていません`,
  "cli.source.invalidId": ({ sub, id }: { sub: string; id: string }): string =>
    `source ${sub}: 不正な <id> '${id}' ([A-Za-z0-9][A-Za-z0-9._-]* に一致する必要があります)`,
  "cli.source.kindRequired": "source add: --kind が必要です",
  "cli.source.urlRequired": "source add: --url が必要です",
  "cli.source.invalidKind": ({ kind }: { kind: string }): string =>
    `source add: 不正な --kind '${kind}' (有効値: rss | html | html-js | github-releases | npm-registry | json-feed | json-api)`,
  "cli.source.paginationOnlyJsonApi": ({ kind }: { kind: string }): string =>
    `source add: --pagination-* フラグは --kind json-api でのみ有効です (--kind '${kind}' が指定されています)`,
  "cli.source.validationFailed": "source add: 検証に失敗しました",
  "cli.source.recipeForbiddenFlags": ({
    recipe,
    flags,
  }: {
    recipe: string;
    flags: string;
  }): string =>
    `source add: --recipe '${recipe}' が kind / url / 構造フィールドを供給します。--recipe と併用できないフラグ: ${flags}`,
  "cli.source.recipeInvalidSource": ({ recipe }: { recipe: string }): string =>
    `source add: レシピ '${recipe}' が不正な source を生成しました`,
  "cli.source.alreadyExists": ({ id }: { id: string }): string =>
    `source add: '${id}' は既に存在します (sources/${id}.yaml)`,
  "cli.source.created": ({ id }: { id: string }): string =>
    `source add: sources/${id}.yaml を作成しました`,
  "cli.source.createdFromRecipe": ({ id, recipe }: { id: string; recipe: string }): string =>
    `source add: レシピ '${recipe}' から sources/${id}.yaml を作成しました`,
  "cli.source.noKeywordsWarn": ({ id }: { id: string }): string =>
    `source add: 警告 — '${id}' にキーワードがありません。取得した全アイテムが除外されます。取り込みを始めるには sources/${id}.yaml を編集するか --keywords 付きで再追加してください。`,
  "cli.source.noKeywordsWarnRecipe": ({ id }: { id: string }): string =>
    `source add: 警告 — '${id}' にキーワードがありません。取得した全アイテムが除外されます。取り込みを始めるには --keywords 付きで再追加するか sources/${id}.yaml を編集してください。`,
  "cli.source.listNoDir":
    "source list: sources ディレクトリがありません (まず `radar init` を実行してください)",
  "cli.source.listNoSources":
    "source list: source が定義されていません (`radar source add ...` を使用してください)",
  "cli.source.removeNotFound": ({ id }: { id: string }): string =>
    `source remove: '${id}' が見つかりません (sources/${id}.yaml)`,
  "cli.source.deleted": ({ id }: { id: string }): string =>
    `source remove: sources/${id}.yaml を削除しました`,
  "cli.source.testNotFound": ({ id }: { id: string }): string =>
    `source test: '${id}' が見つかりません (sources/${id}.yaml)`,
  "cli.source.recipesNone":
    "source recipes: バンドルされたレシピがありません (recipes/ が空または存在しません)",
  "cli.source.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `source: 不明なサブコマンド '${sub}' です`,

  // triage (#336)
  "cli.triage.modesExclusive": "--dry-run / --apply / --interactive は併用できません",
  "cli.triage.verboseQuietExclusive": "--verbose と --quiet は併用できません",
  "cli.triage.commitIncompatibleModes":
    "triage: --commit と --dry-run / --apply / --interactive は併用できません",
  "cli.triage.commitIncompatibleEmitPayload": "triage: --commit と --emit-payload は併用できません",
  "cli.triage.emitPayloadIncompatibleModes":
    "triage: --emit-payload と --dry-run / --apply / --interactive は併用できません",
  "cli.triage.emitPayloadSingleSource": ({
    count,
    sources,
  }: {
    count: number;
    sources: string;
  }): string =>
    `triage: --emit-payload は単一の source グループが必要ですが、${count} 個の source に detected アイテムがあります (${sources})。--source <id> で絞り込んでください。`,
  "cli.triage.invalidTriageAgent": ({ agent }: { agent: string }): string =>
    `triage: --triage-agent '${agent}' は有効な agent id ではありません (claude-code | codex-cli | gemini-cli | copilot)`,
  "cli.triage.noSourcesDir":
    "triage: sources/ ディレクトリがありません (まず `radar init` を実行してください)",
  "cli.triage.noSourcesDefined": "triage: source が定義されていません。triage 対象がありません",
  "cli.triage.noItemsDir": "triage: items/ ディレクトリがありません。triage 対象がありません",
  "cli.triage.noDetectedMatch":
    "triage: フィルタに一致する detected アイテムがありません (処理対象なし)",
  "cli.triage.maxItemsExceeded": ({
    detected,
    maxItems,
  }: {
    detected: number;
    maxItems: number;
  }): string =>
    `triage: detected アイテム ${detected} 件が --max-items ${maxItems} を超えています。先頭の ${maxItems} 件のみ処理します`,
  "cli.triage.skippingNoPolicy": ({
    count,
    sourceId,
  }: {
    count: number;
    sourceId: string;
  }): string =>
    `triage: source '${sourceId}' の ${count} 件をスキップします (triagePolicy が設定されていません)`,
  "cli.triage.noItemsTriaged": "triage: triage されたアイテムがありません (全 source をスキップ)",
  "cli.triage.dryRunNoChanges": "triage: dry-run — 変更は書き込まれていません",
  "cli.triage.abortedByUser": "triage: ユーザーにより中止されました",
  "cli.triage.applied": ({ count }: { count: number }): string =>
    `triage: ${count} 件の判定を適用しました`,
  "cli.triage.committed": ({ count, sourceId }: { count: number; sourceId: string }): string =>
    `triage: source '${sourceId}' の ${count} 件の判定を commit しました`,
  "cli.triage.decisionsFileNotFound": ({ path }: { path: string }): string =>
    `triage: decisions ファイルが見つかりません: ${path}`,
  "cli.triage.unknownSource": ({ sourceId }: { sourceId: string }): string =>
    `triage: decisions ファイルが未知の source '${sourceId}' を参照しています`,
  "cli.triage.sourceNoPolicy": ({ sourceId }: { sourceId: string }): string =>
    `triage: source '${sourceId}' に triagePolicy がありません (decisions を検証できません。--policy <path> を指定してください)`,
  "cli.triage.noItemsDirCommit": "triage: items/ ディレクトリがありません。commit 対象がありません",
  "cli.triage.noDetectedForSource": ({ sourceId }: { sourceId: string }): string =>
    `triage: source '${sourceId}' に残っている detected アイテムがありません (既に triage 済みか、source が間違っていませんか?)`,
  "cli.triage.invalidDecisionsAgent": ({ agent }: { agent: string }): string =>
    `triage: decisions ファイルの agent '${agent}' は有効な agent id ではありません (claude-code | codex-cli | gemini-cli | copilot)`,
  "cli.triage.feedbackMissingItemId": "triage feedback: <item-id> が指定されていません",
  "cli.triage.feedbackModesExclusive": "triage feedback: --correct と --wrong は併用できません",
  "cli.triage.feedbackModeRequired": "triage feedback: --correct | --wrong のいずれかが必要です",
  "cli.triage.feedbackItemsDirNotFound":
    "triage feedback: items/ が見つかりません (`radar init` を実行してください)",
  "cli.triage.feedbackItemNotFound": ({ id }: { id: string }): string =>
    `triage feedback: アイテム '${id}' が items/ 配下に見つかりません`,
  "cli.triage.feedbackNoPriorDecision": ({ id }: { id: string }): string =>
    `triage feedback: アイテム '${id}' にフィードバック対象の triage 判定がありません`,
  "cli.triage.feedbackRecorded": ({
    sourceId,
    id,
    verdict,
  }: {
    sourceId: string;
    id: string;
    verdict: string;
  }): string =>
    `triage feedback: items/${sourceId}/${id}.yaml のフィードバックを ${verdict} に設定しました`,
  "cli.triage.statsInvalidSince": ({ since }: { since: string }): string =>
    `triage stats: 不正な --since '${since}' (形式: Ns | Nm | Nh | Nd)`,
  "cli.triage.statsNoItemsDir":
    "triage stats: items/ ディレクトリがありません (まず `radar init` を実行してください)",
  "cli.triage.statsNoMatch":
    "triage stats: フィルタに一致する triage 済みアイテムがありません (報告対象なし)",

  // --- init help (#311) -----------------------------------------------------
  "cli.init.help": `使い方: radar init [--lang <en|ja>] [--force] [--with-routines] [--with-actions]
                          [--no-claude-skills] [--no-gemini-commands]
                          [--no-agents-md] [--no-claude-md] [--no-templates]
                          [--no-feedradar-md]

ワークスペースのディレクトリを作成し、バンドル済みスキルをコピーする:
  - エンジン SKILL (SSoT): .agents/skills/{research,review,update}/SKILL.md
  - Claude Code スラッシュコマンドラッパー: .claude/skills/{research,review,update,dismiss}/SKILL.md
  - Gemini CLI スラッシュコマンド: .gemini/commands/{research,review,update,dismiss}.toml
  - エージェント非依存の指示書: AGENTS.md (Codex / Gemini / Copilot が自動で読む)
  - Claude Code 用ワークスペース指示書: CLAUDE.md (@AGENTS.md を import し Claude が読むようにする)
  - スターターレポートテンプレート: templates/default.md (単一アイテム) と templates/digest.md (複数アイテムのダイジェスト)
  - 人間向けワークスペースガイド: FEEDRADAR.md (自然言語 / スラッシュの使い方)

オプション:
  --lang <en|ja>         生成するレポートテンプレートとワークスペース文書の言語
                         (既定: en; RADAR_LANG も尊重; radar.config.yaml に永続化)
  --force                既存ファイルを上書きする
  --with-routines        .claude/routines/watch-daily.yaml (Claude Routines の雛形) と
                         .claude/skills/routine-setup/SKILL.md (Claude 専用の登録 skill) を生成する
  --with-actions         .github/workflows/watch.yaml を生成する (GitHub Actions cron の雛形)
  --no-claude-skills     .claude/skills/ へのスラッシュコマンドラッパー書き込みをスキップする
                         (@ozzylabs/skills の Renovate preset がそのディレクトリを管理する場合に有用)
  --no-gemini-commands   .gemini/commands/ への Gemini CLI スラッシュコマンド書き込みをスキップする
                         (エンジン SKILL は dual-mode で対話 Gemini にも対応する)
  --no-agents-md         ワークスペースルートへの AGENTS.md 書き込みをスキップする
                         (ワークスペースに独自の AGENTS.md がある場合に有用;
                          バンドル CLAUDE.md は @AGENTS.md を import するため --no-claude-md を含意する)
  --no-claude-md         ワークスペースルートへの CLAUDE.md 書き込みをスキップする
                         (ワークスペースに独自の CLAUDE.md がある場合に有用)
  --no-templates         templates/default.md と templates/digest.md の書き込みをスキップする
                         (research エンジン SKILL は組み込みの構造にフォールバックする)
  --no-feedradar-md      ワークスペースルートへの FEEDRADAR.md 書き込みをスキップする
                         (ワークスペースに独自のユーザー向け文書がある場合に有用)`,

  // --- 総チェック follow-up: dispatcher エラー (#342 A1) ---------------------
  "cli.workflow.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `workflow: 不明なサブコマンド '${sub}' です`,
  "cli.workflow.unknownType": ({ type }: { type: string }): string =>
    `workflow generate: 不明なタイプ '${type}' です`,
  "cli.routine.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `routine: 不明なサブコマンド '${sub}' です`,
  "cli.routine.unknownType": ({ type }: { type: string }): string =>
    `routine generate: 不明なタイプ '${type}' です`,

  // --- 総チェック follow-up: workflow generate サマリ (#342 A2) --------------
  "cli.workflow.generateWatchWrote": ({ path }: { path: string }): string =>
    `workflow generate watch: ${path} を書き込みました`,
  "cli.workflow.generateWatchSummary": ({ cron, agent }: { cron: string; agent: string }): string =>
    `workflow generate watch: cron='${cron}', agent='${agent}'`,
  "cli.workflow.generateWatchOverwriting": ({ path }: { path: string }): string =>
    `workflow generate watch: 既存ファイル ${path} を上書きします`,
  "cli.workflow.requiredSecretsHeading":
    "必要な GitHub Actions シークレット (Settings → Secrets and variables → Actions):",
  "cli.workflow.secretCopilotToken": "  GITHUB_TOKEN — GitHub Actions が自動発行 (手動設定不要)",
  "cli.workflow.secretAgentKey": ({ envKey, agent }: { envKey: string; agent: string }): string =>
    `  ${envKey} — '${agent}' エージェントに必要`,
  "cli.workflow.secretGithubTokenAuto": "  GITHUB_TOKEN — GitHub Actions が自動発行 (手動設定不要)",
  "cli.workflow.generateCombinedWrote": ({ path }: { path: string }): string =>
    `workflow generate combined: ${path} を書き込みました`,
  "cli.workflow.generateCombinedOverwriting": ({ path }: { path: string }): string =>
    `workflow generate combined: 既存ファイル ${path} を上書きします`,
  "cli.workflow.detailAgent": ({ agent }: { agent: string }): string => `  agent:       ${agent}`,
  "cli.workflow.detailCron": ({ cron }: { cron: string }): string => `  cron:        ${cron}`,
  "cli.workflow.detailMaxItems": ({ maxItems }: { maxItems: number }): string =>
    `  max-items:   ${maxItems}`,
  "cli.workflow.detailFilterTags": ({ tags }: { tags: string }): string => `  filter-tags: ${tags}`,
  "cli.workflow.filterTagsNone": "(なし)",
  "cli.workflow.maxItemsCapWarning": ({ cmd }: { cmd: string }): string =>
    `${cmd}: --max-items の上限は \`radar research --batch\` 側でも強制されます。YAML を編集するだけでは引き上げられません`,
  "cli.workflow.generateCombinedWithTriageWrote": ({ path }: { path: string }): string =>
    `workflow generate combined-with-triage: ${path} を書き込みました`,
  "cli.workflow.generateCombinedWithTriageOverwriting": ({ path }: { path: string }): string =>
    `workflow generate combined-with-triage: 既存ファイル ${path} を上書きします`,
  "cli.workflow.detailWatchCron": ({ cron }: { cron: string }): string =>
    `  watch-cron:     ${cron}`,
  "cli.workflow.detailTriageAgent": ({ agent }: { agent: string }): string =>
    `  triage-agent:   ${agent}`,
  "cli.workflow.detailResearchAgent": ({ agent }: { agent: string }): string =>
    `  research-agent: ${agent}`,
  "cli.workflow.detailReviewAgent": ({ agent }: { agent: string }): string =>
    `  review-agent:   ${agent}`,
  "cli.workflow.detailMaxItemsWide": ({ maxItems }: { maxItems: number }): string =>
    `  max-items:      ${maxItems}`,
  "cli.workflow.detailOutputMode": ({ mode }: { mode: string }): string =>
    `  output-mode:    ${mode}`,
  "cli.workflow.detailSlackWebhook": ({ webhook }: { webhook: string }): string =>
    `  slack-webhook:  ${webhook}`,
  "cli.workflow.slackWebhookNone": "(なし — 通知ステップは no-op)",
  "cli.workflow.secretsNoneAutoToken":
    "  (なし — 選択した全エージェントが自動発行の GITHUB_TOKEN を利用)",
  "cli.workflow.secretGithubTokenAutoNoSetup": "  GITHUB_TOKEN (自動発行、設定不要)",

  // --- 総チェック follow-up: routine generate サマリ (#342 A2) ---------------
  "cli.routine.generateWatchWrote": ({ path }: { path: string }): string =>
    `routine generate watch: ${path} を書き込みました`,
  "cli.routine.generateWatchSummary": ({
    name,
    repo,
    cron,
    model,
  }: {
    name: string;
    repo: string;
    cron: string;
    model: string;
  }): string =>
    `routine generate watch: name='${name}', repo='${repo}', cron='${cron}', model='${model}'`,
  "cli.routine.generateWatchOverwriting": ({ path }: { path: string }): string =>
    `routine generate watch: 既存ファイル ${path} を上書きします`,
  "cli.routine.generatePipelineWrote": ({ path }: { path: string }): string =>
    `routine generate pipeline: ${path} を書き込みました`,
  "cli.routine.generatePipelineSummary": ({
    name,
    repo,
    cron,
    model,
    maxItems,
    outputMode,
  }: {
    name: string;
    repo: string;
    cron: string;
    model: string;
    maxItems: number;
    outputMode: string;
  }): string =>
    `routine generate pipeline: name='${name}', repo='${repo}', cron='${cron}', model='${model}', max-items=${maxItems}, output-mode='${outputMode}'`,
  "cli.routine.generatePipelineOverwriting": ({ path }: { path: string }): string =>
    `routine generate pipeline: 既存ファイル ${path} を上書きします`,
  "cli.routine.autoMergeWarning": ({ cmd }: { cmd: string }): string =>
    `${cmd}: --output-mode auto-merge は ` +
    "`allow_unrestricted_git_push: true` を設定しますが、これは必要条件であって十分条件ではありません。" +
    "Web UI の 'Allow unrestricted branch pushes' トグルも ON にする必要があります " +
    "(RemoteTrigger API はこのフィールドを受け付けません)。なお、その場合は無人の AI 出力が " +
    "人間のレビューなしでデフォルトブランチに入る点に注意してください。",
  "cli.routine.pasteNoApi":
    "Routines には宣言的な apply API がありません。この routine を Web UI に手で貼り付けてください:",
  "cli.routine.pasteStep1":
    "  1. https://claude.ai/code/routines を開き New routine をクリックします。",
  "cli.routine.pasteStep2":
    "  2. YAML からフォーム項目を埋めます (Name / Model / Repositories / Trigger / Permissions)。",
  "cli.routine.pasteStep3":
    "  3. 複数行の Instructions / Setup script フィールドは yq で抽出します:",
  "cli.routine.pasteYqInstructions": ({ path }: { path: string }): string =>
    `       yq -r '.instructions'             ${path}`,
  "cli.routine.pasteYqSetupScript": ({ path }: { path: string }): string =>
    `       yq -r '.environment.setup_script' ${path}`,
  // --prompt-mode bootstrap (#327)
  "cli.routine.pasteStep3Bootstrap":
    "  3. Instructions 欄には、この短い bootstrap プロンプトを貼り付けます (prompt-mode bootstrap):",
  // bootstrap プロンプト本文の正本 — 左寄せ (行頭インデントなし)。機械消費
  // (`--emit-bootstrap-prompt` → routine の `message.content`) で使うため、行頭空白は
  // ゼロでなければならない (#377)。Web UI 貼付表示の表示用インデントは
  // `printPromptModePaste` 側で付与する。
  "cli.routine.bootstrapPromptLine1": ({ name }: { name: string }): string =>
    `You are the \`${name}\` routine.`,
  "cli.routine.bootstrapPromptLine2": ({ path }: { path: string }): string =>
    `Read \`${path}\` in this repository and faithfully execute its top-level`,
  "cli.routine.bootstrapPromptLine3":
    "`instructions:` block. Run autonomously: AskUserQuestion is NOT available,",
  "cli.routine.bootstrapPromptLine4":
    "and local MCP servers are NOT available in this environment.",
  "cli.routine.pasteStep3BootstrapSetup":
    "     複数行の Setup script フィールドは yq で抽出します:",
  "cli.routine.bootstrapReuseNote":
    "     (bootstrap プロンプト: 以降の instructions 変更はリポへのコミットで反映され、Web UI への再貼り付けは不要です。)",
  "cli.routine.pasteStep4":
    "  4. 登録後、発行された routine_id (trig_xxxx) を YAML に書き戻し、status: active を設定します。",
  // /routine-setup skill hint (#367): 上記の Web UI 手貼りフローの代替。skill は
  // 正本 YAML を読んで RemoteTrigger API で登録 (または再適用) するため、手順 1-4 が
  // 1 コマンドにまとまる。RemoteTrigger ツールは Claude Code harness が in-process で
  // 注入するため Claude 専用 — Web UI フローを置き換えるのではなく併記して案内する。
  "cli.routine.setupSkillHint1":
    "Claude Code をお使いですか? /routine-setup skill で上記の手順を自動化できます:",
  "cli.routine.setupSkillHint2":
    "この YAML を読み込み、RemoteTrigger API 経由で routine を登録 (または再適用) します",
  "cli.routine.setupSkillHint3": "— Web UI での手動登録に代わる Claude 専用の手段です。",
  "cli.routine.scheduleNote1":
    "/schedule (Claude Code) について: 対話形式です — `/schedule <説明>` で作成し、",
  "cli.routine.scheduleNote2":
    "`list` / `update` / `run` サブコマンドが使えます。フラグ形式 (`--name` / `--cron` /",
  "cli.routine.scheduleNote3":
    "`--repo` 引数) はありません。またこの YAML をそのまま取り込むこともできないため、",
  "cli.routine.scheduleNote4":
    "長い Instructions フィールドについては上記の Web UI 貼り付けフロー (yq 抽出) が",
  "cli.routine.scheduleNote5":
    "現実的な手段です。最後に、auto-merge routine が必要とする unrestricted-git-push 権限は",
  "cli.routine.scheduleNote6":
    "Web UI の 'Allow unrestricted branch pushes' トグルでのみ設定でき、/schedule では",
  "cli.routine.scheduleNote7": "設定できません。",
  "cli.routine.outputGateBranchPr":
    "出力ゲート: この routine は claude/* ブランチ / PR にのみ書き込みます — main へは直接書き込みません。",
  "cli.routine.outputGateAutoMerge":
    "出力ゲート: この routine は claude/* PR を開いてから main へ squash-merge します (手順 6 のレビューでレビュー完了)。",
  "cli.routine.pipelineNoSpawn1":
    "単一の Claude セッション、spawn なし: GHA combined-with-triage ワークフローと異なり、",
  "cli.routine.pipelineNoSpawn2":
    "ここにクロスエージェントレビューはありません — 1 つの Claude が全ステップを実行します。",
  "cli.routine.pipelineItemCaps": ({ maxItems }: { maxItems: number }): string =>
    `アイテム上限は CLI で強制されます: triage --max-items ${maxItems} / items --limit ${maxItems}。`,
  "cli.routine.fireTriggered": ({
    routineId,
    status,
  }: {
    routineId: string;
    status: number;
  }): string => `routine fire: ${routineId} を起動しました (HTTP ${status})。`,
  "cli.routine.fireSessionCreated": "セッションが作成されました — この呼び出しは完了を待ちません。",

  // --- 総チェック follow-up: init 運用警告 (#342 A3) -------------------------
  "cli.init.bundledSkillNotFound": ({ src }: { src: string }): string =>
    `init: バンドルされた skill が見つからないためスキップしました: ${src}`,
  "cli.init.bundledClaudeSkillNotFound": ({ src }: { src: string }): string =>
    `init: バンドルされた claude discovery skill が見つからないためスキップしました: ${src}`,
  "cli.init.bundledGeminiCommandNotFound": ({ src }: { src: string }): string =>
    `init: バンドルされた gemini コマンドが見つからないためスキップしました: ${src}`,
  "cli.init.bundledTemplateNotFound": ({ src }: { src: string }): string =>
    `init: バンドルされたテンプレートが見つからないためスキップしました: ${src}`,
  "cli.init.skippedExisting": ({ file }: { file: string }): string =>
    `init: 既存ファイルをスキップしました (上書きするには --force): ${file}`,
  "cli.init.skippedClaudeMdNoAgentsMd":
    "init: --no-agents-md が指定されたため CLAUDE.md をスキップしました (バンドルの CLAUDE.md は @AGENTS.md を import するため import が解決できなくなります)",
  "cli.init.configLocaleNotYaml": ({ file, reason }: { file: string; reason: string }): string =>
    `init: ${file} の locale 書き込みをスキップしました (既存ファイルが有効な YAML ではありません: ${reason})`,
  "cli.init.configLocaleNotMapping": ({ file }: { file: string }): string =>
    `init: ${file} の locale 書き込みをスキップしました (既存ファイルがマッピングではありません)`,
  "cli.init.configLocaleSkippedUpdate": ({
    file,
    current,
    locale,
  }: {
    file: string;
    current: string;
    locale: string;
  }): string =>
    `init: ${file} の locale '${current}' -> '${locale}' への更新をスキップしました (上書きするには --force)`,

  // --- 総チェック follow-up: source list/test/recipes 表示 (#342 A4) ---------
  "cli.source.fieldKind": ({ value }: { value: string }): string => `  kind:           ${value}`,
  "cli.source.fieldUrl": ({ value }: { value: string }): string => `  url:            ${value}`,
  "cli.source.fieldName": ({ value }: { value: string }): string => `  name:           ${value}`,
  "cli.source.fieldTags": ({ value }: { value: string }): string => `  tags:           ${value}`,
  "cli.source.fieldKeywords": ({ value }: { value: string }): string =>
    `  keywords:       ${value}`,
  "cli.source.fieldExcludeKeywords": ({ value }: { value: string }): string =>
    `  excludeKeywords: ${value}`,
  "cli.source.fieldTrustLevel": ({ value }: { value: string }): string =>
    `  trustLevel:     ${value}`,
  "cli.source.fieldLastFetchedAt": ({ value }: { value: string }): string =>
    `  lastFetchedAt:  ${value}`,
  "cli.source.keywordsEmpty": "(なし — アイテムはフィルタで除外されます)",
  "cli.source.valueNone": "-",
  "cli.source.listHeaderId": "ID",
  "cli.source.listHeaderKind": "KIND",
  "cli.source.listHeaderUrl": "URL",
  "cli.source.listHeaderTags": "TAGS",
  "cli.source.testHeading": ({ id }: { id: string }): string => `source test: ${id}`,
  "cli.source.testCounts": ({
    fetched,
    filtered,
    matched,
  }: {
    fetched: number;
    filtered: number;
    matched: number;
  }): string => `  取得: ${fetched} / フィルタ後: ${filtered} / 一致: ${matched}`,
  "cli.source.facetSweepNotice": ({
    facet,
    testedValue,
    totalValues,
  }: {
    facet: string;
    testedValue: string | number;
    totalValues: number;
  }): string =>
    `source test: facet sweep 有効: ${facet}=${testedValue} のみ test 中 (全 ${totalValues} 件の facet 値は walk しません)。` +
    "range facet は上端 (最新値) を test します。全 facet 値を確認するには `radar watch run --backfill` を使用してください。",
  "cli.source.selectorAdoptionHeading": "  selector adoption:",
  "cli.source.selectorNoCandidate": ({ field }: { field: string }): string =>
    `    ${field}: (一致する候補なし)`,
  "cli.source.selectorAdopted": ({ field, path }: { field: string; path: string }): string =>
    `    ${field} ← ${path} を採用`,
  "cli.source.paginationPreviewHeading":
    "  pagination preview (page 0 のみ — state は変更されません):",
  "cli.source.paginationStrategy": ({ strategy }: { strategy: string }): string =>
    `    strategy:  ${strategy}`,
  "cli.source.paginationNextUrl": ({ nextUrl }: { nextUrl: string }): string =>
    `    nextUrl:   ${nextUrl}`,
  "cli.source.paginationEndOfPagination": "(ページネーション終端)",
  "cli.source.paginationLinkNext": ({ value }: { value: string }): string =>
    `    Link rel=next: ${value}`,
  "cli.source.paginationNextCursor": ({ value }: { value: string }): string =>
    `    nextCursor: ${value}`,
  "cli.source.paginationAbsent": "(なし)",
  "cli.source.testNoMatched": "  (一致したアイテムはありません)",
  "cli.source.testShowing": ({ shown, total }: { shown: number; total: number }): string =>
    `一致した ${total} 件のうち ${shown} 件を表示:`,
  "cli.source.testItemTitle": ({ index, title }: { index: number; title: string }): string =>
    `  ${index}. ${title}`,
  "cli.source.testItemUrl": ({ url }: { url: string }): string => `     url:             ${url}`,
  "cli.source.testItemMatchedKeywords": ({ value }: { value: string }): string =>
    `     matchedKeywords: ${value}`,
  "cli.source.testItemMatchedFields": ({ value }: { value: string }): string =>
    `     matchedFields:   ${value}`,
  "cli.source.testItemContent": ({ value }: { value: string }): string =>
    `     content:         ${value}`,
  "cli.source.testMoreItems": ({ count }: { count: number }): string =>
    `  … 他 ${count} 件 (--limit を上げると表示されます)`,
  "cli.source.recipesNoValid":
    "source recipes: 有効なレシピが見つかりません (バンドルされた全エントリの読み込みに失敗)",
  "cli.source.recipesHeaderName": "NAME",
  "cli.source.recipesHeaderKind": "KIND",
  "cli.source.recipesHeaderDescription": "DESCRIPTION",
  "cli.source.recipesErrorsHeading": "エラーのあるレシピ:",
  "cli.source.recipesErrorRow": ({ name, error }: { name: string; error: string }): string =>
    `  ${name}: ${error}`,
  "cli.source.recipesErrorUnknown": "(不明なエラー)",
  "cli.source.recipesApplyHeading": "レシピの適用方法:",
  "cli.source.recipesApplyExample":
    "  radar source add <id> --recipe <name> [--keywords <kw>] [--tags <t>] [--name <display>]",

  // --- 総チェック follow-up: triage 進捗 + 確認プロンプト (#342 A6/B1) -------
  "cli.triage.progressTriaging": ({
    count,
    sourceId,
    agent,
  }: {
    count: number;
    sourceId: string;
    agent: string;
  }): string => `ソース '${sourceId}' の ${count} 件を ${agent} で triage 中`,
  "cli.triage.confirmApply": "これらの判定を適用しますか? [y/N]",

  // --- state prune (#333) ---------------------------------------------------
  "cli.state.help": `使い方: radar state prune <source> --keep <N>

state/<source>.yaml の lastSeenIds を新しい順に N 件だけ残して切り詰める (FIFO・古いものから削除)。
facet sweep で肥大化した state ファイルを縮小する用途。

オプション:
  --keep <N>          新しい順に N 件残し、残りを削除する (必須)
  --older-than <dur>  未対応 (lastSeenIds は id ごとの時刻を持たない)
  -h, --help          このヘルプを表示する`,
  "cli.state.parseError": ({ reason }: { reason: string }): string => `state prune: ${reason}`,
  "cli.state.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `state: 不明なサブコマンド '${sub}'`,
  "cli.state.missingSource": "state prune: <source> が指定されていません",
  "cli.state.keepRequired": "state prune: --keep <N> は必須です",
  "cli.state.olderThanUnsupported":
    "state prune: --older-than は未対応です (lastSeenIds は id ごとの時刻を持ちません)。--keep <N> を使ってください",
  "cli.state.invalidKeepInteger": ({ raw }: { raw: string }): string =>
    `state prune: --keep には整数を指定してください ('${raw}' が指定されました)`,
  "cli.state.invalidKeepPositive": ({ raw }: { raw: string }): string =>
    `state prune: --keep には正の整数を指定してください ('${raw}' が指定されました)`,
  "cli.state.sourceNotFound": ({ sourceId }: { sourceId: string }): string =>
    `state prune: ソース '${sourceId}' の state が見つかりません (state/${sourceId}.yaml)`,
  "cli.state.pruneNoop": ({
    sourceId,
    count,
    keep,
  }: {
    sourceId: string;
    count: number;
    keep: number;
  }): string =>
    `state prune: '${sourceId}' は既に ${count} 件 (--keep ${keep} 以下) のため切り詰め不要です`,
  "cli.state.pruneDone": ({
    sourceId,
    before,
    after,
    dropped,
  }: {
    sourceId: string;
    before: number;
    after: number;
    dropped: number;
  }): string =>
    `state prune: '${sourceId}' の lastSeenIds を ${before} -> ${after} に切り詰めました (${dropped} 件削除)`,
};
