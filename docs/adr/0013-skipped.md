# ADR-0013: (Skipped)

## Status

Not Applicable — 番号予約のみ。決定内容なし。

## Context

ADR-0012 (JSON API Adapter and Recipe Bundling Strategy) の設計検討初期に、
recipe バンドル戦略 (A/B/C) を **独立 ADR (ADR-0013)** として切り出す案が
案 X5 として検討されたが、却下された ([ADR-0012 §Alternatives X5](./0012-json-api-adapter-and-recipe-strategy.md#案-x5-adr-0013-を別途起こして-recipe-バンドル戦略を独立-adr-化))。

却下理由 (要約):

- バンドル戦略は `kind: json-api` 汎用化方針と一体の判断であり、独立 ADR の実益が薄い
- ADR 数を増やすと cross-link が複雑化、navigation 悪化
- ADR-0012 に統合することで「なぜ汎用化したのに公式 recipe を同梱するのか」の因果関係が一読で追える

結果、本番号 (0013) は **欠番** として残置することになった。

## Decision

なし (ADR-0012 §X5 を参照)。

## Why this file exists

[ADR README](./README.md) の rule「番号は **次の連番**を採る (status が
`Superseded` でも欠番にしない)」を守るため、欠番をそのまま放置せず本ファイルで
**「予約された番号、決定なし」** であることを明示する。

将来 ADR-0013 として独立判断が必要になった場合、本ファイルを上書きせず
新規 ADR (ADR-NNNN) として起票し、本ファイルは Not Applicable のまま残す。
